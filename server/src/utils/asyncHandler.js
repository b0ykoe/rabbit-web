/**
 * Wrap an async Express route handler to catch rejected promises.
 * Without this, unhandled rejections crash the process in Express 4.
 *
 * Usage: router.get('/', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
