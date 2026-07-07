import { useState, useEffect, useCallback } from 'react';
import { adminApi } from '../../../api/endpoints.js';
import { VARIANT_OPTIONS } from './CreateServerDialog.jsx';

// Legacy fallback set — the curated trio the picker shipped with before variants
// were managed rows. Used verbatim when the variants API can't be reached so the
// server create/edit forms are NEVER blocked by a variants-endpoint failure.
const FALLBACK_OPTIONS = VARIANT_OPTIONS.map((name) => ({ name, display_name: null }));

// Data-driven variant picker options. Fetches the managed (non-archived) variant
// rows once and exposes them as [{ name, display_name }] for the server forms'
// Select. On error it falls back to the legacy trio so the form stays usable.
//   { options, loading, reload }
export function useVariantOptions() {
  const [options, setOptions] = useState(FALLBACK_OPTIONS);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.getVariants();
      const rows = res?.data || [];
      // Map to the minimal shape the pickers need; drop archived defensively even
      // though the API already filters them out by default.
      const mapped = rows
        .filter((r) => !r.archived)
        .map((r) => ({ name: r.name, display_name: r.display_name || null }));
      setOptions(mapped.length ? mapped : FALLBACK_OPTIONS);
    } catch {
      // Never block the form — degrade to the legacy trio.
      setOptions(FALLBACK_OPTIONS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return { options, loading, reload };
}
