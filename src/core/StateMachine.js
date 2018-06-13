import { UnhandledEventError, StateMachineNotStartedError, StateMachineConfigError } from './Errors';
import invokeEach from '../utils/invokeEach';

const noop = () => {};
const stopped = Symbol('StateMachine:stopped');
const symHandlerThrewError = Symbol('StateMachine::symHandlerThrewError');
export const ignoreHandlerResult = Symbol('StateMachine::ignoreHandlerResult');

export default class StateMachine {
  constructor(config, taskScheduler, contextFactory) {
    if (config === undefined || config === null) {
      throw new StateMachineConfigError('Configuration must be specified.');
    }
    if (config === null || typeof config !== 'object') {
      throw new StateMachineConfigError('Configuration must be an object.');
    }
    if (
      config.global === null ||
      typeof config.global !== 'object' ||
      !(config.states instanceof Map) ||
      Array.from(config.states.values()).filter(x => (x === null || typeof x !== 'object')).length > 0 ||
    false) {
      throw new StateMachineConfigError('Configuration is malformed.');
    }
    this.config = config;
    this.taskScheduler = taskScheduler;
    this.contextFactory = contextFactory;
    this.currentState = stopped;
    this.submachines = new Map();
    this.stateData = new Map(Array.from(this.config.states.keys()).map(state => ([state, {}])));
    this.timerIDs = null;
    this.asyncActionCancelers = null;
    this.handleAsyncActionComplete = this.handleAsyncActionComplete.bind(this);
    this.handleTimeout = this.handleTimeout.bind(this);
  }

  getCurrentState() {
    return this.currentState;
  }

  getStateData(state) {
    return this.stateData.get(state);
  }

  getCurrentStateData() {
    return this.getStateData(this.currentState);
  }

  async canHandle(event, eventPayload) {
    if (!this.isStarted()) {
      return false;
    }

    const context = this.createContextWithEvent(event, eventPayload);
    return !!(await this.getFirstAllowedTransitionForEvent(context));
  }

  handle(event, eventPayload) {
    return (async () => {
      if (!this.isStarted()) {
        throw new StateMachineNotStartedError(this, 'Cannot handle events before starting the state machine!');
      }
      const context = this.createContextWithEvent(event, eventPayload);
      const transitionConfig = await this.getFirstAllowedTransitionForEvent(context);
      if (transitionConfig) {
        return await this.executeTransition(transitionConfig, context);
      }
      return await this.handleUnhandledEvent(event, eventPayload);
    })().catch(err => { throw err; });
  }

  async handleUnhandledEvent(event, eventPayload) {
    const context = this.createContextWithEvent(event, eventPayload);
    if (this.config.global.unhandledEventHooks.length > 0) {
      const handlerResults = (await invokeEach.bind(context.stateMachine)(
        this.config.global.unhandledEventHooks.map(
          handler => (async (...args) => {
            try {
              return await handler(...args);
            } catch (e) {
              return [symHandlerThrewError, e];
            }
          })
        ),
        event,
        this.currentState,
        context
      )).filter(x => x !== ignoreHandlerResult);
      const handlerSuccesses = handlerResults.filter(result =>
        !Array.isArray(result) ||
        result[0] !== symHandlerThrewError);
      const handlerFailures = handlerResults.filter(result =>
        Array.isArray(result) &&
        result[0] === symHandlerThrewError
      );
      if (handlerFailures.length > 0) throw handlerFailures[0];
      if (handlerSuccesses.length > 0) return handlerSuccesses.filter(x => x !== undefined)[0];
    }
    throw new UnhandledEventError(
      event,
      this.currentState,
      context
    );
  }

  isStarted() {
    return this.currentState !== stopped;
  }

  async start() {
    if (!this.isStarted()) {
      await this.enterState(this.config.initialState, this.createContext());
    }
    return this;
  }

  async stop() {
    if (this.isStarted()) {
      await this.exitState(this.createContext());
      this.currentState = stopped;
    }
    return this;
  }

  getSubmachine() {
    return this.isStarted() ? this.submachines.get(this.currentState) : null;
  }

  async executeTransition(transitionConfig, context) {
    if (!transitionConfig.isInternal && !transitionConfig.ignore) {
      await this.exitState(context);
    }

    const nextState = transitionConfig.targetState !== null ?
      transitionConfig.targetState :
      this.currentState;

    if (!transitionConfig.ignore) {
      await invokeEach.bind(context.stateMachine)(
        this.config.global.transitionHooks,
        this.currentState,
        nextState,
        context
      );
    }

    const actionRetvals = await invokeEach.bind(context.stateMachine)(
      transitionConfig.actions,
      this.currentState,
      nextState,
      context
    );

    if (!transitionConfig.isInternal && !transitionConfig.ignore) {
      await this.enterState(nextState, context);
    }

    return (actionRetvals.length > 1 ? actionRetvals : actionRetvals[0]);
  }

  async enterState(state, context) {
    await invokeEach.bind(context.stateMachine)(this.config.global.stateEnterHooks, state, context);

    const stateConfig = this.config.states.get(state);
    if (stateConfig) {
      await invokeEach.bind(context.stateMachine)(stateConfig.entryActions, state, context);
    }

    if (this.currentState !== stopped && this.currentState !== state) {
      await invokeEach.bind(context.stateMachine)(
        this.config.global.stateChangeHooks,
        this.currentState,
        state,
        context
      );
    }

    try {
      this.startAsyncActions(state, context);
      this.startTimers(state);
      await this.startSubmachines(state);
    } catch (error) {
      this.stopTimers();
      this.cancelAsyncActions();
      throw error;
    }

    this.currentState = state;
  }

  async exitState(context) {
    await this.stopSubmachines();
    this.stopTimers();
    this.cancelAsyncActions();

    await invokeEach.bind(context.stateMachine)(
      this.config.global.stateExitHooks,
      this.currentState,
      context
    );

    const stateConfig = this.config.states.get(this.currentState);
    if (stateConfig) {
      await invokeEach.bind(context.stateMachine)(
        stateConfig.exitActions,
        this.currentState,
        context
      );
    }
  }

  startAsyncActions(state, context) {
    const stateConfig = this.config.states.get(state);
    if (stateConfig) {
      stateConfig.asyncActions.forEach(
        asyncActionConfig => this.startAsyncAction(asyncActionConfig, state, context)
      );
    }
  }

  startAsyncAction(asyncActionConfig, state, context) {
    this.taskScheduler.enqueue(() => {
      const { action, successTrigger, failureTrigger } = asyncActionConfig;
      let handleComplete = this.handleAsyncActionComplete;
      this.taskScheduler.enqueue(async () => {
        action(state, context).then(
          result => handleComplete(successTrigger, { result }),
          error => handleComplete(failureTrigger, { error })
        );
      }).then(null, x => { throw x; });
      this.asyncActionCancelers = this.asyncActionCancelers || [];
      this.asyncActionCancelers.push(() => {
        handleComplete = noop;
      });
    }).then(null, x => { throw x; });
  }

  cancelAsyncActions() {
    if (this.asyncActionCancelers) {
      this.asyncActionCancelers.forEach(x => x());
      this.asyncActionCancelers = null;
    }
  }

  async handleAsyncActionComplete(triggerConfig, additionalContext) {
    const context = Object.assign(this.createContext(), additionalContext);
    await this.executeTrigger(triggerConfig, context);
  }

  startTimers(state) {
    const stateConfig = this.config.states.get(state);
    if (stateConfig && stateConfig.timers.length > 0) {
      this.timerIDs = stateConfig.timers.map(timerConfig => setTimeout(
        this.handleTimeout,
        timerConfig.timeout,
        timerConfig
      ));
    }
  }

  stopTimers() {
    if (this.timerIDs) {
      this.timerIDs.forEach(clearTimeout);
      this.timerIDs = null;
    }
  }

  handleTimeout(timerConfig) {
    this.executeTrigger(timerConfig, this.createContext()).then(null, x => { throw x; });
  }

  async startSubmachines(state) {
    const stateConfig = this.config.states.get(state);
    if (stateConfig && stateConfig.submachine) {
      if (!this.submachines.get(state)) {
        this.submachines.set(state, new StateMachine(
          stateConfig.submachine, this.taskScheduler, this.contextFactory
        ));
      }
      await this.submachines.get(state).start();
    }
  }

  async stopSubmachines() {
    const submachine = this.submachines.get(this.currentState);
    if (submachine) {
      await submachine.stop();
    }
  }

  createContext() {
    return this.contextFactory(this);
  }

  createContextWithEvent(event, eventPayload) {
    const context = this.createContext();
    context.event = event;
    if (eventPayload !== undefined) {
      context.eventPayload = eventPayload;
    }
    return context;
  }

  static async getFirstAllowedTransition(transitions, context) {
    for (let i = 0; i < transitions.length; i++) {
      if (!transitions[i].condition) return transitions[i];
      // eslint-disable-next-line no-await-in-loop
      if (await transitions[i].condition.bind(context.stateMachine)(context)) return transitions[i];
    }
    return null;
  }

  async getFirstAllowedTransitionForEvent(context) {
    const stateConfig = this.config.states.get(this.currentState);
    if (!stateConfig) {
      return null;
    }

    let transitionConfig = null;

    const eventConfig = stateConfig.events.get(context.event);
    if (eventConfig) {
      transitionConfig = await StateMachine.getFirstAllowedTransition(
        eventConfig.transitions,
        context
      );
    }

    if (!transitionConfig && stateConfig.anyEventTrigger) {
      transitionConfig = await StateMachine.getFirstAllowedTransition(
        stateConfig.anyEventTrigger.transitions, context
      );
    }

    return transitionConfig;
  }

  async executeTrigger(triggerConfig, context) {
    return await this.taskScheduler.enqueue(async () => {
      const transitionConfig = await StateMachine.getFirstAllowedTransition(
        triggerConfig.transitions, context
      );
      if (transitionConfig) {
        return await this.executeTransition(transitionConfig, context);
      }
      return undefined;
    });
  }
}
