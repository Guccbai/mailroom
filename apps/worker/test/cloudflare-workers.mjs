// Node stand-in for the Workers runtime module, used only by Vitest.
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
  }
}
export class DurableObject extends WorkerEntrypoint {}
export const env = {}
