import { useRef, useState } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, Button, CircularProgress, Skeleton,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import StatusDot from './StatusDot.jsx';
import { deriveCoverage } from './deriveCoverage.js';

// The determinate progress ring with a centred % label.
function ProgressRing({ value, ready }) {
  return (
    <Box sx={{ position: 'relative', display: 'inline-flex' }}>
      <CircularProgress
        variant="determinate"
        value={100}
        size={84}
        thickness={4}
        sx={{ color: 'action.hover', position: 'absolute', left: 0 }}
      />
      <CircularProgress
        variant="determinate"
        value={value}
        size={84}
        thickness={4}
        color={ready ? 'success' : 'warning'}
      />
      <Box
        sx={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Typography variant="h6" fontWeight={700}>{value}%</Typography>
      </Box>
    </Box>
  );
}

function VerdictChip({ cov }) {
  if (cov.verdict === 'ready') {
    return <Chip size="small" color="success" icon={<CheckCircleIcon sx={{ fontSize: 16 }} />} label="Ready" />;
  }
  if (cov.verdict === 'not_published') {
    return <Chip size="small" color="warning" variant="outlined" label="Not published — publish in Settings" />;
  }
  const n = cov.stepsLeft;
  return <Chip size="small" color="warning" variant="outlined" label={`${n} step${n === 1 ? '' : 's'} left`} />;
}

// A single checklist row: status dot + label + hint + a Fix action when missing.
function StepRow({ step, onFix, fixLabel, busy }) {
  const actionable = !step.done && !!onFix;
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25, py: 0.75 }}>
      <Box sx={{ mt: 0.25 }}>
        <StatusDot
          state={step.done ? 'done' : (step.optional ? 'inert' : 'missing')}
          title={step.done ? 'Done' : (step.optional ? 'Optional — not done' : 'Missing')}
        />
      </Box>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography variant="body2" fontWeight={600} sx={{ lineHeight: 1.3 }}>
          {step.label}
          {step.optional && (
            <Typography component="span" variant="caption" color="text.disabled" sx={{ ml: 0.75 }}>
              optional
            </Typography>
          )}
        </Typography>
        {step.hint && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {step.hint}
          </Typography>
        )}
      </Box>
      {actionable && (
        <Box sx={{ flexShrink: 0 }}>{fixLabel}</Box>
      )}
      {step.done && !step.optional && (
        <CheckCircleIcon sx={{ fontSize: 18, color: 'success.main', flexShrink: 0, mt: 0.25 }} />
      )}
    </Box>
  );
}

// The setup-completeness centrepiece: a progress ring + a fix-it checklist. Fix
// actions:
//   names       -> hidden file input -> importServerNames(id, file) -> refetch()
//   background  -> onOpenTab('uploads')
//   ips/visible -> onOpenTab('settings')
// A loading skeleton keeps the same shape while the row/overview resolve.
export default function SetupCompletenessCard({ server, overview, refetch, onOpenTab, loading }) {
  const { showSnackbar } = useSnackbar();
  const namesInputRef = useRef(null);
  const [importing, setImporting] = useState(false);

  if (loading && !server) {
    return (
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Stack direction="row" spacing={2.5} alignItems="center">
          <Skeleton variant="circular" width={84} height={84} />
          <Box sx={{ flexGrow: 1 }}>
            <Skeleton variant="text" width="40%" height={28} />
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} variant="text" width="80%" height={24} />
            ))}
          </Box>
        </Stack>
      </Paper>
    );
  }

  const cov = deriveCoverage(server, overview);

  const onNamesPicked = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setImporting(true);
    try {
      const res = await adminApi.importServerNames(server.id, file);
      showSnackbar(`Names imported — ${res?.zones ?? 0} zones, ${res?.mobs ?? 0} monsters`);
      refetch?.();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Name import failed', 'error');
    } finally {
      setImporting(false);
    }
  };

  // Per-step Fix control.
  const fixFor = (step) => {
    switch (step.key) {
      case 'names':
        return (
          <>
            <input
              ref={namesInputRef}
              type="file"
              accept=".json,.csv"
              hidden
              onChange={onNamesPicked}
            />
            <Button
              size="small"
              variant="outlined"
              disabled={importing}
              onClick={() => namesInputRef.current?.click()}
            >
              {importing ? 'Importing…' : 'Import'}
            </Button>
          </>
        );
      case 'background':
        return (
          <Button size="small" variant="outlined" onClick={() => onOpenTab?.('uploads')}>
            Upload
          </Button>
        );
      case 'ips':
        return (
          <Button size="small" variant="text" onClick={() => onOpenTab?.('settings')}>
            Add
          </Button>
        );
      case 'visible':
        return (
          <Button size="small" variant="outlined" onClick={() => onOpenTab?.('settings')}>
            Publish
          </Button>
        );
      case 'name':
        return (
          <Button size="small" variant="text" onClick={() => onOpenTab?.('settings')}>
            Rename
          </Button>
        );
      default:
        return null;
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2.5}
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        sx={{ mb: 1.5 }}
      >
        <ProgressRing value={cov.pct} ready={cov.ready} />
        <Box sx={{ flexGrow: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" sx={{ rowGap: 0.5 }}>
            <Typography variant="subtitle1" fontWeight={700}>Setup completeness</Typography>
            <VerdictChip cov={cov} />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            What this server needs before it is useful on the user-facing map.
          </Typography>
        </Box>
      </Stack>

      <Box>
        {cov.steps.map((step) => (
          <StepRow key={step.key} step={step} onFix={fixFor} fixLabel={fixFor(step)} />
        ))}
      </Box>
    </Paper>
  );
}
