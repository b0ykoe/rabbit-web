import { Tooltip } from '@mui/material';
import LabelIcon from '@mui/icons-material/Label';
import ScatterPlotIcon from '@mui/icons-material/ScatterPlot';
import CropFreeIcon from '@mui/icons-material/CropFree';
import ImageIcon from '@mui/icons-material/Image';

// A MEANINGFUL per-asset status icon: unlike the generic StatusDot check/X, the
// glyph itself tells you WHICH asset type a cell is about, and its MUI color
// conveys state:
//   present            -> "success" (green)   — the asset exists.
//   missing+actionable -> "warning" (amber)   — an upload/import can fix it.
//   missing+inert      -> "disabled" (grey)   — nothing to upload (e.g. spawn
//                         data, which only a recording bot can fill).
// `kind` picks the glyph; `present` + `actionable` pick the color/tooltip.
const KIND = {
  named:      { Icon: LabelIcon,       label: 'Named' },
  data:       { Icon: ScatterPlotIcon, label: 'Spawn data' },
  bounds:     { Icon: CropFreeIcon,    label: 'Bounds' },
  background: { Icon: ImageIcon,       label: 'Background' },
};

export default function AssetStatusIcon({ kind, present, actionable = true, size = 18 }) {
  const cfg = KIND[kind] || KIND.named;
  const { Icon, label } = cfg;

  const color = present ? 'success' : (actionable ? 'warning' : 'disabled');

  let title;
  if (present) {
    title = `${label}: present`;
  } else if (actionable) {
    title = `${label}: missing — upload/import to fix`;
  } else {
    title = `${label}: missing — recorded by a bot, not uploadable`;
  }

  return (
    <Tooltip title={title}>
      <Icon
        color={color}
        sx={{ fontSize: size, verticalAlign: 'middle', display: 'inline-block' }}
        aria-label={title}
      />
    </Tooltip>
  );
}
