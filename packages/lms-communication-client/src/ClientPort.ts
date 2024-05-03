import {
  changeErrorStackInPlace,
  getCurrentStack,
  LazySignal,
  makePromise,
  OWLSignal,
  SimpleLogger,
  text,
  Validator,
  type LoggerInterface,
  type NotAvailable,
  type Setter,
  type WriteTag,
} from "@lmstudio/lms-common";
import type {
  BackendInterface,
  ChannelEndpoint,
  ClientTransport,
  ClientTransportFactory,
  RpcEndpoint,
  ServerToClientMessage,
} from "@lmstudio/lms-communication";
import { Channel } from "@lmstudio/lms-communication";
import {
  type ChannelEndpointsSpecBase,
  type RpcEndpointsSpecBase,
  type SignalEndpoint,
  type SignalEndpointsSpecBase,
  type WritableSignalEndpoint,
  type WritableSignalEndpointsSpecBase,
} from "@lmstudio/lms-communication/dist/BackendInterface";
import { fromSerializedError, type SerializedLMSExtendedError } from "@lmstudio/lms-shared-types";
import { applyPatches, enablePatches, type Patch } from "immer";

enablePatches();

interface OpenChannel {
  endpoint: ChannelEndpoint;
  stack: string;
  channel: Channel<any, any>;
  receivedAck: (ackId: number) => void;
  receivedMessage: (message: any) => void;
  errored: (error: any) => void;
  closed: () => void;
}

interface OngoingRpc {
  endpoint: RpcEndpoint;
  stack: string;
  resolve: (result: any) => void;
  reject: (error: any) => void;
}

interface OpenSignalSubscription {
  endpoint: SignalEndpoint;
  getValue: () => any;
  setValue: (value: any, tags: Array<WriteTag>) => void;
  errored: (error: any) => void;
  stack?: string;
}

interface OpenWritableSignalSubscription {
  endpoint: WritableSignalEndpoint;
  getValue: () => any;
  setValue: (value: any, tags: Array<WriteTag>) => void;
  errored: (error: any) => void;
  stack?: string;
}

function defaultErrorDeserializer(serialized: SerializedLMSExtendedError, stack?: string): Error {
  const error = fromSerializedError(serialized);
  if (stack === undefined) {
    changeErrorStackInPlace(error, "");
  } else {
    changeErrorStackInPlace(error, stack);
  }
  return error;
}

export class ClientPort<
  TRpcEndpoints extends RpcEndpointsSpecBase,
  TChannelEndpoints extends ChannelEndpointsSpecBase,
  TSignalEndpoints extends SignalEndpointsSpecBase,
  TWritableSignalEndpoints extends WritableSignalEndpointsSpecBase,
> {
  private readonly transport: ClientTransport;
  private readonly logger;
  private openChannels = new Map<number, OpenChannel>();
  private ongoingRpcs = new Map<number, OngoingRpc>();
  private openSignalSubscriptions = new Map<number, OpenSignalSubscription>();
  private openWritableSignalSubscriptions = new Map<number, OpenWritableSignalSubscription>();
  private openCommunicationsCount = 0;
  private nextChannelId = 0;
  private nextSubscribeId = 0;
  private nextWritableSubscribeId = 0;
  private producedCommunicationWarningsCount = 0;
  private errorDeserializer: (serialized: SerializedLMSExtendedError, stack?: string) => Error;
  private verboseErrorMessage: boolean;

  public constructor(
    private readonly backendInterface: BackendInterface<
      unknown,
      TRpcEndpoints,
      TChannelEndpoints,
      TSignalEndpoints,
      TWritableSignalEndpoints
    >,
    factory: ClientTransportFactory,
    {
      parentLogger,
      errorDeserializer,
      verboseErrorMessage,
    }: {
      parentLogger?: LoggerInterface;
      errorDeserializer?: (serialized: SerializedLMSExtendedError) => Error;
      verboseErrorMessage?: boolean;
    } = {},
  ) {
    this.logger = new SimpleLogger("ClientPort", parentLogger);
    this.errorDeserializer = errorDeserializer ?? defaultErrorDeserializer;
    this.verboseErrorMessage = verboseErrorMessage ?? false;
    this.transport = factory(this.receivedMessage, this.errored, this.logger);
  }

  private communicationWarning(warning: string) {
    if (this.producedCommunicationWarningsCount >= 5) {
      return;
    }
    this.logger.warnText`
      Produced communication warning: ${warning}
      
      This is usually caused by communication protocol incompatibility. Please make sure you are
      using the up-to-date versions of the SDK and LM Studio.
    `;
    this.transport.send({
      type: "communicationWarning",
      warning,
    });
    this.producedCommunicationWarningsCount++;
    if (this.producedCommunicationWarningsCount >= 5) {
      this.logger.errorText`
        5 communication warnings have been produced. Further warnings will not be printed.
      `;
    }
  }

  private updateOpenCommunicationsCount() {
    const previousCount = this.openCommunicationsCount;
    this.openCommunicationsCount =
      this.openChannels.size +
      this.ongoingRpcs.size +
      this.openSignalSubscriptions.size +
      this.openWritableSignalSubscriptions.size;
    if (this.openCommunicationsCount === 0 && previousCount > 0) {
      this.transport.onHavingNoOpenCommunication();
    } else if (this.openCommunicationsCount === 1 && previousCount === 0) {
      this.transport.onHavingOneOrMoreOpenCommunication();
    }
  }

  private receivedChannelSend(message: ServerToClientMessage & { type: "channelSend" }) {
    const openChannel = this.openChannels.get(message.channelId);
    if (openChannel === undefined) {
      this.communicationWarning(
        `Received channelSend for unknown channel, channelId = ${message.channelId}`,
      );
      return;
    }
    const parsed = openChannel.endpoint.toClientPacket.safeParse(message.message);
    if (!parsed.success) {
      this.communicationWarning(text`
        Received invalid message for channel: endpointName = ${openChannel.endpoint.name}, message =
        ${message.message}. Zod error:

        ${Validator.prettyPrintZod("message", parsed.error)}
      `);
      return;
    }
    openChannel.receivedMessage(parsed.data);
  }

  private receivedChannelAck(message: ServerToClientMessage & { type: "channelAck" }) {
    const openChannel = this.openChannels.get(message.channelId);
    if (openChannel === undefined) {
      this.communicationWarning(
        `Received channelAck for unknown channel, channelId = ${message.channelId}`,
      );
      return;
    }
    openChannel.receivedAck(message.ackId);
  }

  private receivedChannelClose(message: ServerToClientMessage & { type: "channelClose" }) {
    const openChannel = this.openChannels.get(message.channelId);
    if (openChannel === undefined) {
      this.communicationWarning(
        `Received channelClose for unknown channel, channelId = ${message.channelId}`,
      );
      return;
    }
    this.openChannels.delete(message.channelId);
    openChannel.closed();
    this.updateOpenCommunicationsCount();
  }

  private receivedChannelError(message: ServerToClientMessage & { type: "channelError" }) {
    const openChannel = this.openChannels.get(message.channelId);
    if (openChannel === undefined) {
      this.communicationWarning(
        `Received channelError for unknown channel, channelId = ${message.channelId}`,
      );
      return;
    }
    this.openChannels.delete(message.channelId);
    const error = this.errorDeserializer(
      message.error,
      this.verboseErrorMessage ? openChannel.stack : undefined,
    );
    openChannel.errored(error);
    this.updateOpenCommunicationsCount();
  }

  private receivedRpcResult(message: ServerToClientMessage & { type: "rpcResult" }) {
    const ongoingRpc = this.ongoingRpcs.get(message.callId);
    if (ongoingRpc === undefined) {
      this.communicationWarning(`Received rpcResult for unknown rpc, callId = ${message.callId}`);
      return;
    }
    const parsed = ongoingRpc.endpoint.returns.safeParse(message.result);
    if (!parsed.success) {
      this.communicationWarning(text`
        Received invalid result for rpc, endpointName = ${ongoingRpc.endpoint.name}, result =
        ${message.result}. Zod error:

        ${Validator.prettyPrintZod("result", parsed.error)}
      `);
      return;
    }
    ongoingRpc.resolve(parsed.data);
    this.ongoingRpcs.delete(message.callId);
    this.updateOpenCommunicationsCount();
  }

  private receivedRpcError(message: ServerToClientMessage & { type: "rpcError" }) {
    const ongoingRpc = this.ongoingRpcs.get(message.callId);
    if (ongoingRpc === undefined) {
      this.communicationWarning(`Received rpcError for unknown rpc, callId = ${message.callId}`);
      return;
    }
    const error = this.errorDeserializer(
      message.error,
      this.verboseErrorMessage ? ongoingRpc.stack : undefined,
    );
    ongoingRpc.reject(error);
    this.ongoingRpcs.delete(message.callId);
    this.updateOpenCommunicationsCount();
  }

  private receivedSignalUpdate(message: ServerToClientMessage & { type: "signalUpdate" }) {
    const openSignalSubscription = this.openSignalSubscriptions.get(message.subscribeId);
    if (openSignalSubscription === undefined) {
      this.communicationWarning(
        `Received signalUpdate for unknown signal, subscribeId = ${message.subscribeId}`,
      );
      return;
    }
    const patches = message.patches;
    const beforeValue = openSignalSubscription.getValue();
    const afterValue = applyPatches(openSignalSubscription.getValue(), patches);
    const parseResult = openSignalSubscription.endpoint.signalData.safeParse(afterValue);
    if (!parseResult.success) {
      this.communicationWarning(text`
        Received invalid signal patch data, subscribeId = ${message.subscribeId}

        patches = ${patches},

        beforeValue = ${beforeValue},

        afterValue = ${afterValue}.

        Zod error:

        ${Validator.prettyPrintZod("value", parseResult.error)}
      `);
      return;
    }
    openSignalSubscription.setValue(parseResult.data, message.tags);
  }

  private receivedSignalError(message: ServerToClientMessage & { type: "signalError" }) {
    const openSignalSubscription = this.openSignalSubscriptions.get(message.subscribeId);
    if (openSignalSubscription === undefined) {
      this.communicationWarning(
        `Received signalError for unknown signal, subscribeId = ${message.subscribeId}`,
      );
      return;
    }
    const error = this.errorDeserializer(
      message.error,
      this.verboseErrorMessage ? openSignalSubscription.stack : undefined,
    );
    openSignalSubscription.errored(error);
    this.openSignalSubscriptions.delete(message.subscribeId);
    this.updateOpenCommunicationsCount();
  }

  private receivedWritableSignalUpdate(
    message: ServerToClientMessage & { type: "writableSignalUpdate" },
  ) {
    const openSignalSubscription = this.openWritableSignalSubscriptions.get(message.subscribeId);
    if (openSignalSubscription === undefined) {
      this.communicationWarning(
        `Received writableSignalUpdate for unknown signal, subscribeId = ${message.subscribeId}`,
      );
      return;
    }
    const patches = message.patches;
    const beforeValue = openSignalSubscription.getValue();
    const afterValue = applyPatches(openSignalSubscription.getValue(), patches);
    const parseResult = openSignalSubscription.endpoint.signalData.safeParse(afterValue);
    if (!parseResult.success) {
      this.communicationWarning(text`
        Received invalid writable signal patch data, subscribeId = ${message.subscribeId}

        patches = ${patches},

        beforeValue = ${beforeValue},

        afterValue = ${afterValue}.

        Zod error:

        ${Validator.prettyPrintZod("value", parseResult.error)}
      `);
      return;
    }
    openSignalSubscription.setValue(parseResult.data, message.tags);
  }

  private receivedWritableSignalError(
    message: ServerToClientMessage & { type: "writableSignalError" },
  ) {
    const openSignalSubscription = this.openWritableSignalSubscriptions.get(message.subscribeId);
    if (openSignalSubscription === undefined) {
      this.communicationWarning(
        `Received writableSignalError for unknown signal, subscribeId = ${message.subscribeId}`,
      );
      return;
    }
    const error = this.errorDeserializer(
      message.error,
      this.verboseErrorMessage ? openSignalSubscription.stack : undefined,
    );
    openSignalSubscription.errored(error);
    this.openWritableSignalSubscriptions.delete(message.subscribeId);
    this.updateOpenCommunicationsCount();
  }

  private receivedCommunicationWarning(
    message: ServerToClientMessage & { type: "communicationWarning" },
  ) {
    this.logger.warnText`
      Received communication warning from the server: ${message.warning}
      
      This is usually caused by communication protocol incompatibility. Please make sure you are
      using the up-to-date versions of the SDK and LM Studio.

      Note: This warning was received from the server and is printed on the client for convenience.
    `;
  }

  private receivedKeepAliveAck(_message: ServerToClientMessage & { type: "keepAliveAck" }) {
    // Do nothing
  }

  private receivedMessage = (message: ServerToClientMessage) => {
    switch (message.type) {
      case "channelSend": {
        this.receivedChannelSend(message);
        break;
      }
      case "channelAck": {
        this.receivedChannelAck(message);
        break;
      }
      case "channelClose": {
        this.receivedChannelClose(message);
        break;
      }
      case "channelError": {
        this.receivedChannelError(message);
        break;
      }
      case "rpcResult": {
        this.receivedRpcResult(message);
        break;
      }
      case "rpcError": {
        this.receivedRpcError(message);
        break;
      }
      case "signalUpdate": {
        this.receivedSignalUpdate(message);
        break;
      }
      case "signalError": {
        this.receivedSignalError(message);
        break;
      }
      case "writableSignalUpdate": {
        this.receivedWritableSignalUpdate(message);
        break;
      }
      case "writableSignalError": {
        this.receivedWritableSignalError(message);
        break;
      }
      case "communicationWarning": {
        this.receivedCommunicationWarning(message);
        break;
      }
      case "keepAliveAck": {
        this.receivedKeepAliveAck(message);
        break;
      }
    }
  };
  private errored = (error: any) => {
    for (const openChannel of this.openChannels.values()) {
      openChannel.errored(error);
    }
    for (const ongoingRpc of this.ongoingRpcs.values()) {
      ongoingRpc.reject(error);
    }
  };
  public async callRpc<TEndpointName extends keyof TRpcEndpoints & string>(
    endpointName: TEndpointName,
    param: TRpcEndpoints[TEndpointName]["parameter"],
    { stack }: { stack?: string } = {},
  ): Promise<TRpcEndpoints[TEndpointName]["returns"]> {
    const endpoint = this.backendInterface.getRpcEndpoint(endpointName);
    if (endpoint === undefined) {
      throw new Error(`No Rpc endpoint with name ${endpointName}`);
    }
    const parameter = endpoint.parameter.parse(param);

    const callId = this.nextChannelId;
    this.nextChannelId++;

    const { promise, resolve, reject } = makePromise();

    stack = stack ?? getCurrentStack(1);
    this.ongoingRpcs.set(callId, {
      endpoint,
      stack,
      resolve,
      reject,
    });

    this.transport.send({
      type: "rpcCall",
      endpoint: endpointName,
      callId,
      parameter,
    });

    this.updateOpenCommunicationsCount();

    return await promise;
  }
  public createChannel<TEndpointName extends keyof TChannelEndpoints & string>(
    endpointName: TEndpointName,
    param: TChannelEndpoints[TEndpointName]["creationParameter"],
    onMessage?: (message: TChannelEndpoints[TEndpointName]["toClientPacket"]) => void,
    { stack }: { stack?: string } = {},
  ): Channel<
    TChannelEndpoints[TEndpointName]["toClientPacket"],
    TChannelEndpoints[TEndpointName]["toServerPacket"]
  > {
    const channelEndpoint = this.backendInterface.getChannelEndpoint(endpointName);
    if (channelEndpoint === undefined) {
      throw new Error(`No channel endpoint with name ${endpointName}`);
    }
    const creationParameter = channelEndpoint.creationParameter.parse(param);

    const channelId = this.nextChannelId;
    this.nextChannelId++;

    this.transport.send({
      type: "channelCreate",
      endpoint: endpointName,
      channelId,
      creationParameter,
    });

    stack = stack ?? getCurrentStack(1);

    const openChannel: OpenChannel = {
      endpoint: channelEndpoint,
      stack,
      ...Channel.create(packet => {
        const result = channelEndpoint.toServerPacket.parse(packet);
        this.transport.send({
          type: "channelSend",
          channelId,
          message: result,
        });
      }),
    };

    if (onMessage !== undefined) {
      openChannel.channel.onMessage.subscribe(onMessage);
    }

    this.openChannels.set(channelId, openChannel);
    this.updateOpenCommunicationsCount();
    return openChannel.channel;
  }
  /**
   * Creates a readonly lazy signal will subscribe to the signal endpoint with the given name.
   */
  public createSignal<TEndpointName extends keyof TSignalEndpoints & string>(
    endpointName: TEndpointName,
    param: TSignalEndpoints[TEndpointName]["creationParameter"],
    { stack }: { stack?: string } = {},
  ): LazySignal<TSignalEndpoints[TEndpointName]["signalData"] | NotAvailable> {
    const signalEndpoint = this.backendInterface.getSignalEndpoint(endpointName);
    if (signalEndpoint === undefined) {
      throw new Error(`No signal endpoint with name ${endpointName}`);
    }
    const creationParameter = signalEndpoint.creationParameter.parse(param);

    stack = stack ?? getCurrentStack(1);

    const signal = LazySignal.createWithoutInitialValue((listener, errorListener) => {
      const subscribeId = this.nextSubscribeId;
      this.nextSubscribeId++;
      this.transport.send({
        type: "signalSubscribe",
        endpoint: endpointName,
        subscribeId,
        creationParameter,
      });
      this.openSignalSubscriptions.set(subscribeId, {
        endpoint: signalEndpoint,
        getValue: () => signal.get(),
        setValue: listener,
        errored: errorListener,
        stack,
      });
      this.updateOpenCommunicationsCount();
      return () => {
        this.transport.send({
          type: "signalUnsubscribe",
          subscribeId,
        });
      };
    });

    return signal;
  }

  public createWritableSignal<TEndpointName extends keyof TWritableSignalEndpoints & string>(
    endpointName: TEndpointName,
    param: TWritableSignalEndpoints[TEndpointName]["creationParameter"],
    { stack }: { stack?: string } = {},
  ): [
    signal: OWLSignal<TWritableSignalEndpoints[TEndpointName]["signalData"] | NotAvailable>,
    setter: Setter<TWritableSignalEndpoints[TEndpointName]["signalData"]>,
  ] {
    const signalEndpoint = this.backendInterface.getWritableSignalEndpoint(endpointName);
    if (signalEndpoint === undefined) {
      throw new Error(`No writable signal endpoint with name ${endpointName}`);
    }
    const creationParameter = signalEndpoint.creationParameter.parse(param);

    stack = stack ?? getCurrentStack(1);

    let currentSubscribeId: number | null = null;
    const writeUpstream = (_data: any, patches: Array<Patch>, tags: Array<WriteTag>) => {
      if (currentSubscribeId === null) {
        throw new Error("writeUpstream called when not subscribed");
      }
      this.transport.send({
        type: "writableSignalUpdate",
        subscribeId: currentSubscribeId,
        patches,
        tags,
      });
    };

    const [signal, setter] = OWLSignal.createWithoutInitialValue((listener, errorListener) => {
      const subscribeId = this.nextWritableSubscribeId;
      currentSubscribeId = subscribeId;
      this.nextWritableSubscribeId++;
      this.transport.send({
        type: "writableSignalSubscribe",
        endpoint: endpointName,
        subscribeId,
        creationParameter,
      });
      this.openWritableSignalSubscriptions.set(subscribeId, {
        endpoint: signalEndpoint,
        getValue: () => signal.get(),
        setValue: listener,
        errored: errorListener,
        stack,
      });
      this.updateOpenCommunicationsCount();
      return () => {
        currentSubscribeId = null;
        this.transport.send({
          type: "writableSignalUnsubscribe",
          subscribeId,
        });
      };
    }, writeUpstream);
    return [signal, setter];
  }
}

export type InferClientPort<TBackendInterfaceOrCreator> =
  TBackendInterfaceOrCreator extends BackendInterface<
    infer _TContext,
    infer TRpcEndpoints,
    infer TChannelEndpoints,
    infer TSignalEndpoints,
    infer TWritableSignalEndpoints
  >
    ? ClientPort<TRpcEndpoints, TChannelEndpoints, TSignalEndpoints, TWritableSignalEndpoints>
    : TBackendInterfaceOrCreator extends () => BackendInterface<
          infer _TContext,
          infer TRpcEndpoints,
          infer TChannelEndpoints,
          infer TSignalEndpoints,
          infer TWritableSignalEndpoints
        >
      ? ClientPort<TRpcEndpoints, TChannelEndpoints, TSignalEndpoints, TWritableSignalEndpoints>
      : never;
