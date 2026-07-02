// A small tagged union for async-loaded data: not-yet-started, in-flight,
// loaded, or failed. Lets components render each state explicitly instead of
// juggling separate value/loading/error variables.
export type AsyncState<T> =
  | {type: 'empty'}
  | {type: 'loading'}
  | {type: 'value'; value: T}
  | {type: 'error'; message: string};

export const AsyncState = {
  empty: <T>(): AsyncState<T> => ({type: 'empty'}),
  loading: <T>(): AsyncState<T> => ({type: 'loading'}),
  value: <T>(value: T): AsyncState<T> => ({type: 'value', value}),
  error: <T>(message: string): AsyncState<T> => ({type: 'error', message}),
};
