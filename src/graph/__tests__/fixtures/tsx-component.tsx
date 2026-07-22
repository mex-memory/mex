import React, { useState } from "react";
import { Header } from "./Header";

interface Props {
  title: string;
}

export const Widget: React.FC<Props> = ({ title }) => {
  const [count, setCount] = useState(0);

  const increment = () => setCount(count + 1);

  return (
    <div className="widget">
      <Header title={title} />
      <button onClick={increment}>Count {count}</button>
      {/* Ambiguous JSX that safely degrades */}
      <div data-value={ = } />
    </div>
  );
};
