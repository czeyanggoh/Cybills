// Ending a test run on Windows.
//
// A test file exits from the top level while its stub servers — and libuv's own
// handles behind them — are still live, and `process.exit` then tears the loop
// down on top of a handle that is already closing. Node aborts:
//
//     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
//
// which leaves 127 on a run where every check printed PASS, and in the `&&`
// chain `npm test` is, that stops the whole suite naming nothing. So close what
// the test opened, let the loop drain, and only then exit.
export async function finish(
  failures: number,
  ...servers: Array<{ close(): void } | null | undefined>
): Promise<never> {
  for (const s of servers) s?.close();
  await new Promise((r) => setTimeout(r, 100));
  process.exit(failures ? 1 : 0);
}
