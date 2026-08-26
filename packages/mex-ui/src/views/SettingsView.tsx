import { Card, Icon } from "../components/primitives";
import { IdentityCard } from "./panels/IdentityCard";
import type { ProjectSnapshot } from "../lib/types";

export function SettingsView(props: { snapshot: ProjectSnapshot }) {
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <div className="page-head__text">
          <h1>Settings</h1>
          <p className="page-head__sub">This server is bound to one project, locally.</p>
        </div>
      </div>

      <IdentityCard snapshot={props.snapshot} />

      <Card title="About this dashboard" icon={Icon.sliders()}>
        <p className="muted" style={{ fontSize: "0.9rem", maxWidth: "52ch" }}>
          mex ui reads <code className="mono">.mex/</code> and the code graph on this machine. It
          does not contact the network, and it does not mint identity just by being open. Bind
          address, port, and project root are chosen when you start the command — there is nothing
          to configure here yet.
        </p>
      </Card>
    </div>
  );
}
