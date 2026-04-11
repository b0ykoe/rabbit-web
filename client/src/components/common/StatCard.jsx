import { Paper, Typography, Box } from '@mui/material';

export default function StatCard({ label, value, subtitle, icon, color = 'text.primary' }) {
  return (
    <Paper sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {label}
          </Typography>
          <Typography variant="h5" fontWeight={700} color={color} sx={{ mt: 0.5 }}>
            {value}
          </Typography>
          {subtitle && (
            <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5 }}>
              {subtitle}
            </Typography>
          )}
        </Box>
        {icon && (
          <Box sx={{ color: 'text.disabled', mt: 0.5 }}>{icon}</Box>
        )}
      </Box>
    </Paper>
  );
}
