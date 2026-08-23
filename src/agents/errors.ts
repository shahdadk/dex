import type { AgentProvider } from "./types.js";

export class AgentError extends Error {
  constructor(
    message: string,
    readonly provider: AgentProvider,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AgentUnavailableError extends AgentError {}

export class AgentStartupError extends AgentError {}

export class AgentStartupTimeoutError extends AgentStartupError {}

export class AgentCancelledError extends AgentError {}
