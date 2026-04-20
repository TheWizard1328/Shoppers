export const createDashboardViewModel = (props) => ({
  ...props,
  selectedDateStr: props.selectedDateStr || (props.selectedDate ? new Date(props.selectedDate).toISOString().slice(0, 10) : ''),
  isAllDriversMode: props.isAllDriversMode ?? props.selectedDriverId === 'all'
});