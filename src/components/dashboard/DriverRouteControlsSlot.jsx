import React from 'react';
import DriverRouteControls from '@/components/dashboard/DriverRouteControls';
import getDriverRouteControlsProps from '@/components/dashboard/getDriverRouteControlsProps';

export default function DriverRouteControlsSlot(props) {
  return <DriverRouteControls {...getDriverRouteControlsProps(props)} />;
}