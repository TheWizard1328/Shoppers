import React from "react";
import Layout from "../../layout";

export default React.memo(function LayoutContent(props) {
  return <Layout {...props} />;
});