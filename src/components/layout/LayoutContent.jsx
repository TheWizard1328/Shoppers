import React from "react";
import Layout from "../../Layout";

export default React.memo(function LayoutContent(props) {
  return <Layout {...props} />;
});