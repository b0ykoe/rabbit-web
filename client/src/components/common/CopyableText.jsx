import { useState } from 'react';
import { Typography, Tooltip, Box } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';

export default function CopyableText({ text, mono = true }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Tooltip title={copied ? 'Copied!' : 'Click to copy'} placement="top">
      <Box
        onClick={handleCopy}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          cursor: 'pointer',
          '&:hover': { opacity: 0.8 },
        }}
      >
        <Typography
          variant="body2"
          sx={{
            fontFamily: mono ? 'monospace' : 'inherit',
            fontSize: '0.75rem',
            userSelect: 'all',
          }}
        >
          {text}
        </Typography>
        <ContentCopyIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
      </Box>
    </Tooltip>
  );
}
