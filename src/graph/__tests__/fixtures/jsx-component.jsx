import { Section } from "./Section";

export function Page() {
  const loadData = () => {
    return new Promise((resolve) => resolve());
  };

  return (
    <main>
      <Section onMount={loadData} />
    </main>
  );
}
