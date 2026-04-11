import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Paper, TablePagination, Box, CircularProgress, Typography,
} from '@mui/material';

/**
 * Reusable data table with server-side pagination.
 *
 * @param {object} props
 * @param {{ id: string, label: string, render?: Function, align?: string }[]} props.columns
 * @param {object[]} props.rows
 * @param {boolean} props.loading
 * @param {number} props.page - 1-indexed
 * @param {number} props.totalPages
 * @param {number} props.total
 * @param {Function} props.onPageChange - receives new 1-indexed page
 * @param {number} [props.rowsPerPage=25]
 * @param {string} [props.rowKey='id'] - key field for row key
 */
export default function DataTable({
  columns, rows, loading, page, totalPages, total,
  onPageChange, rowsPerPage = 25, rowKey = 'id',
}) {
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  if (!rows?.length) {
    return (
      <Paper sx={{ p: 4, textAlign: 'center' }}>
        <Typography color="text.secondary">No data.</Typography>
      </Paper>
    );
  }

  return (
    <Paper>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              {columns.map((col) => (
                <TableCell key={col.id} align={col.align || 'left'}>
                  {col.label}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row[rowKey]} hover>
                {columns.map((col) => (
                  <TableCell key={col.id} align={col.align || 'left'}>
                    {col.render ? col.render(row) : row[col.id]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {totalPages > 1 && (
        <TablePagination
          component="div"
          count={total}
          page={page - 1} // MUI is 0-indexed
          rowsPerPage={rowsPerPage}
          rowsPerPageOptions={[rowsPerPage]}
          onPageChange={(_, p) => onPageChange(p + 1)}
        />
      )}
    </Paper>
  );
}
