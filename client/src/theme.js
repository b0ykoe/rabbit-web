import { createTheme } from '@mui/material/styles';

const theme = createTheme({
  palette: {
    mode: 'dark',
    background: {
      default: '#09090b', // zinc-950
      paper:   '#18181b', // zinc-900
    },
    primary: {
      main:  '#059669', // emerald-600
      light: '#10b981', // emerald-500
      dark:  '#047857', // emerald-700
    },
    secondary: {
      main: '#a1a1aa', // zinc-400
    },
    error: {
      main: '#ef4444', // red-500
    },
    warning: {
      main: '#f59e0b', // amber-500
    },
    success: {
      main: '#10b981', // emerald-500
    },
    text: {
      primary:   '#f4f4f5', // zinc-100
      secondary: '#a1a1aa', // zinc-400
      disabled:  '#52525b', // zinc-600
    },
    divider: '#3f3f46', // zinc-700
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    fontSize: 13,
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: '1px solid #3f3f46',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 500,
        },
      },
      defaultProps: {
        disableElevation: true,
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderColor: '#3f3f46',
          fontSize: '0.8125rem',
        },
        head: {
          fontWeight: 600,
          color: '#a1a1aa',
          textTransform: 'uppercase',
          fontSize: '0.6875rem',
          letterSpacing: '0.05em',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
          fontSize: '0.6875rem',
          textTransform: 'uppercase',
          letterSpacing: '0.03em',
          height: 22,
        },
        sizeSmall: {
          height: 22,
          fontSize: '0.6875rem',
        },
        label: {
          paddingLeft: 8,
          paddingRight: 8,
        },
        labelSmall: {
          paddingLeft: 6,
          paddingRight: 6,
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          border: '1px solid #3f3f46',
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-notchedOutline': {
            borderColor: '#52525b',
          },
        },
      },
    },
  },
});

export default theme;
