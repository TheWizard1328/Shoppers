export const getTransportModeStyle = (transportMode, fallbackColor = "#2563eb") => {
  switch (transportMode) {
    case "cycling":
      return {
        color: "#16a34a",
        dashArray: "10 6",
        weightBoost: 0,
        opacityBoost: 0
      };
    case "pedestrian":
      return {
        color: "#f59e0b",
        dashArray: "3 8",
        weightBoost: -1,
        opacityBoost: -0.05
      };
    case "driving":
    default:
      return {
        color: fallbackColor,
        dashArray: "",
        weightBoost: 0,
        opacityBoost: 0
      };
  }
};

export const applyTransportModeStyle = ({
  transportMode,
  fallbackColor,
  weight,
  opacity,
  fallbackDashArray = ""
}) => {
  const style = getTransportModeStyle(transportMode, fallbackColor);
  return {
    color: style.color,
    weight: Math.max(2, weight + style.weightBoost),
    opacity: Math.max(0.15, Math.min(1, opacity + style.opacityBoost)),
    dashArray: style.dashArray || fallbackDashArray
  };
};