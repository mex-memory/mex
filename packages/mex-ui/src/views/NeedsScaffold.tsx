import { Button, Card, EmptyState, Icon } from "../components/primitives";

/**
 * Health, Graph, and Activity need a working scaffold. Send the user to setup
 * instead of showing a 409 from those endpoints.
 */
export function NeedsScaffold(props: {
  status: "empty" | "error";
  onSetup: () => void;
}) {
  const empty = props.status === "empty";
  return (
    <Card>
      <EmptyState
        icon={Icon.doc({ size: 18 })}
        title={empty ? "Set up this project first" : "The scaffold needs repair"}
        body={
          empty
            ? "Drift, the code graph, and activity all live in .mex/. Start setup, then come back here."
            : "mex found a .mex/ directory but couldn't load it. Repair it with setup — populated files are never overwritten."
        }
        action={
          <Button variant="primary" onClick={props.onSetup}>
            {empty ? "Start setup" : "Repair with setup"} {Icon.arrowRight()}
          </Button>
        }
      />
    </Card>
  );
}
