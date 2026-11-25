import license from "../../../../LICENSE?raw";

export function OpenSourceLicense() {
  return <details className="disclosure">
    <summary>开源协议 · MIT</summary>
    <pre className="about-license" lang="en">{license}</pre>
  </details>;
}
