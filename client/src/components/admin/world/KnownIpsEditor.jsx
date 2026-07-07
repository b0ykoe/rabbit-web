import { useState } from 'react';
import { Box, Typography, Button, TextField, Chip, Stack } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';

// Basic client-side IP validation. Not exhaustive (the server is authoritative)
// — just enough to catch obvious typos before they land in known_ips. Accepts
// dotted-quad IPv4 (each octet 0-255) and a permissive IPv6 form (hex groups
// separated by ':', allowing a single '::' compression).
const isIpv4 = (s) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255 && String(Number(o)) === o.replace(/^0+(?=\d)/, ''));
};

const isIpv6 = (s) => {
  if (!s.includes(':')) return false;
  // At most one '::' compression, only hex groups (1-4 digits) otherwise.
  if ((s.match(/::/g) || []).length > 1) return false;
  const groups = s.split(':');
  if (groups.length > 8) return false;
  return groups.every((g) => g === '' || /^[0-9a-fA-F]{1,4}$/.test(g));
};

const isValidIp = (s) => isIpv4(s) || isIpv6(s);

// Chip editor for a server's known-IP list. TextField + Add button, Enter-to-add,
// remove chips, client IPv4/IPv6 validation + dedupe. Controlled: {value, onChange}.
export default function KnownIpsEditor({ value = [], onChange, disabled = false }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (!isValidIp(v)) { setError('Not a valid IPv4 or IPv6 address.'); return; }
    if (value.includes(v)) { setError('That IP is already listed.'); return; }
    onChange?.([...value, v]);
    setDraft('');
    setError('');
  };

  const remove = (ip) => onChange?.(value.filter((x) => x !== ip));

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        Known IPs — used to preselect this server for a connecting bot.
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          size="small" placeholder="1.2.3.4" value={draft} disabled={disabled}
          error={!!error} helperText={error || undefined}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          fullWidth
        />
        <Button
          variant="outlined" size="small" startIcon={<AddIcon fontSize="small" />}
          onClick={add} disabled={disabled || !draft.trim()}
          sx={{ alignSelf: 'flex-start', mt: 0.25 }}
        >
          Add
        </Button>
      </Box>
      {value.length === 0 ? (
        <Typography variant="caption" color="text.disabled">No known IPs yet.</Typography>
      ) : (
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          {value.map((ip) => (
            <Chip
              key={ip} label={ip} size="small" variant="outlined"
              onDelete={disabled ? undefined : () => remove(ip)}
              sx={{ fontFamily: 'monospace' }}
            />
          ))}
        </Stack>
      )}
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1 }}>
        Known IPs preselect this server for a bot; spawn data is keyed by server, not IP.
      </Typography>
    </Box>
  );
}
