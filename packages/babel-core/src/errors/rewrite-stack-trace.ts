/**
 * This file uses the iternal V8 Stack Trace API (https://v8.dev/docs/stack-trace-api)
 * to provide utilities to rewrite the stack trace.
 * When this API is not present, all the functions in this file become noops.
 *
 * beginHiddenCallStack(fn) and endHiddenCallStack(fn) wrap their parameter to
 * mark an hidden portion of the stack trace. The function passed to
 * beginHiddenCallStack is the first hidden function, while the function passed
 * to endHiddenCallStack is the first shown function.
 *
 * When an error is thrown _outside_ of the hidden zone, everything between
 * beginHiddenCallStack and endHiddenCallStack will not be shown.
 * If an error is thrown _inside_ the hidden zone, then the whole stack trace
 * will be visible: this is to avoid hiding real bugs.
 * However, if an error inside the hidden zone is expected, it can be marked
 * with the expectedError(error) function to keep the hidden frames hidden.
 *
 * Consider this call stack (the outer function is the bottom one):
 *
 *   1. a()
 *   2. endHiddenCallStack(b)()
 *   3. c()
 *   4. beginHiddenCallStack(d)()
 *   5. e()
 *   6. f()
 *
 * - If a() throws an error, then its shown call stack will be "a, b, e, f"
 * - If b() throws an error, then its shown call stack will be "b, e, f"
 * - If c() throws an expected error, then its shown call stack will be "e, f"
 * - If c() throws an unexpected error, then its shown call stack will be "c, d, e, f"
 * - If d() throws an expected error, then its shown call stack will be "e, f"
 * - If d() throws an unexpected error, then its shown call stack will be "d, e, f"
 * - If e() throws an error, then its shown call stack will be "e, f"
 *
 * Additionally, an error can inject additional "virtual" stack frames using the
 * injcectVirtualStackFrame(error, filename) function: those are injected as a
 * replacement of the hidden frames.
 * In the example above, if we called injcectVirtualStackFrame(err, "h") and
 * injcectVirtualStackFrame(err, "i") on the expected error thrown by c(), its
 * shown call stack would have been "h, i, e, f".
 * This can be useful, for example, to report config validation errors as if they
 * were directly thrown in the config file.
 */

const ErrorToString = Function.call.bind(Error.prototype.toString);

const SUPPORTED = !!Error.captureStackTrace;

// We add some extra frames to Error.stackTraceLimit, so that we can respect
// the original Error.stackTraceLimit even after removing all our internal
// frames.
// STACK_TRACE_LIMIT_DELTA should be bigger than the expected number of internal
// frames, but not too big because capturing the stack trace is slow (this is
// why Error.stackTraceLimit does not default to Infinity!).
// Increase it if needed.
const STACK_TRACE_LIMIT_DELTA = 100;

const START_HIDNG = "startHiding - secret - don't use this - v1";
const STOP_HIDNG = "stopHiding - secret - don't use this - v1";

type CallSite = Parameters<typeof Error.prepareStackTrace>[1][number];

const expectedErrors = new WeakSet<Error>();
const virtualFrames = new WeakMap<Error, CallSite[]>();

function CallSite(filename: string): CallSite {
  // We need to use a prototype otherwise it breaks source-map-support's internals
  return Object.create({
    isNative: () => false,
    isConstructor: () => false,
    isToplevel: () => true,
    getFileName: () => filename,
    getLineNumber: () => undefined,
    getColumnNumber: () => undefined,
    getFunctionName: () => undefined,
    getMethodName: () => undefined,
    getTypeName: () => undefined,
    toString: () => filename,
  } as CallSite);
}

export function injcectVirtualStackFrame(error: Error, filename: string) {
  if (!SUPPORTED) return;

  let frames = virtualFrames.get(error);
  if (!frames) virtualFrames.set(error, (frames = []));
  frames.push(CallSite(filename));

  return error;
}

export function expectedError(error: Error) {
  if (!SUPPORTED) return;
  expectedErrors.add(error);
  return error;
}

export function beginHiddenCallStack<A extends unknown[], R>(
  fn: (...args: A) => R,
) {
  if (!SUPPORTED) return fn;

  return Object.defineProperty(
    function (...args: A) {
      setupPrepareStackTrace();
      return fn(...args);
    },
    "name",
    { value: STOP_HIDNG },
  );
}

export function endHiddenCallStack<A extends unknown[], R>(
  fn: (...args: A) => R,
) {
  if (!SUPPORTED) return fn;

  return Object.defineProperty(
    function (...args: A) {
      return fn(...args);
    },
    "name",
    { value: START_HIDNG },
  );
}

function setupPrepareStackTrace() {
  // @ts-expect-error This function is a singleton
  // eslint-disable-next-line no-func-assign
  setupPrepareStackTrace = () => {};

  const { prepareStackTrace = defaultPrepareStackTrace } = Error;

  Error.stackTraceLimit += STACK_TRACE_LIMIT_DELTA;

  Error.prepareStackTrace = function stackTraceRewriter(err, trace) {
    let newTrace = [];

    const isExpected = expectedErrors.has(err);
    let status: "showing" | "hiding" | "unknown" = isExpected
      ? "hiding"
      : "unknown";
    for (let i = 0; i < trace.length; i++) {
      const name = trace[i].getFunctionName();
      if (name === START_HIDNG) {
        status = "hiding";
      } else if (name === STOP_HIDNG) {
        if (status === "hiding") {
          status = "showing";
          if (virtualFrames.has(err)) {
            newTrace.unshift(...virtualFrames.get(err));
          }
        } else if (status === "unknown") {
          // Unexpected internal error, show the full stack trace
          newTrace = trace;
          break;
        }
      } else if (status !== "hiding") {
        newTrace.push(trace[i]);
      }
    }

    return prepareStackTrace(
      err,
      newTrace.slice(0, Error.stackTraceLimit - STACK_TRACE_LIMIT_DELTA),
    );
  };
}

function defaultPrepareStackTrace(err: Error, trace: CallSite[]) {
  if (trace.length === 0) return ErrorToString(err);
  return `${ErrorToString(err)}\n    at ${trace.join("\n    at ")}`;
}
