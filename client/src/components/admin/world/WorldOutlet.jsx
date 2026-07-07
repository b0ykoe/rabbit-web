import { Outlet } from 'react-router-dom';

// Tiny passthrough so the super-admin guard sits on a single node in the router
// and every child of the /admin/world subtree inherits it.
export default function WorldOutlet() {
  return <Outlet />;
}
