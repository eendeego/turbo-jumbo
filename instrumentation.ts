// Runs once when the Next server boots — dev, `next start`, and the
// standalone Docker bundle alike. This is the official home for startup work,
// which used to live in a custom server (and therefore never ran in the
// standalone build at all). The Node-only work lives in a separate module
// behind the runtime check so the Edge compile of this file never sees
// `node:` imports.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
