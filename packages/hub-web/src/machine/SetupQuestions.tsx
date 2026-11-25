import { useId, useRef } from "react";
import type { MachineSetupQuestion } from "@mex/hub-contracts/machine";
import { Check, Minus, TriangleAlert } from "lucide-react";
import { Button } from "../components/primitives/button";
import { SetupText } from "./SetupText";
import styles from "./setup.module.css";

function Question({ question, reply }: { question: MachineSetupQuestion; reply: (choice: string) => void }) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const { outcome } = question;
  const Icon = outcome?.status === "not saved" ? TriangleAlert : outcome?.status === "skipped" ? Minus : Check;

  function choose(choice: string) {
    heading.current?.focus({ preventScroll: true });
    reply(choice);
  }

  return (
    <li aria-labelledby={id} className={styles.question}>
      <h3 id={id} ref={heading} tabIndex={-1}><SetupText text={question.question} /></h3>
      {question.details.map((text, index) => <p key={index}><SetupText text={text} /></p>)}
      {!outcome && (
        <div aria-labelledby={id} className={styles.actions} role="group">
          {question.choices.map(({ key, label }) => (
            <Button key={key} onClick={() => choose(key)} size="sm" type="button" variant="outline">
              <SetupText text={label} />
              {key === question.suggested && <span className={styles.suggestion}> · Suggested</span>}
            </Button>
          ))}
          <Button onClick={() => choose("skip")} size="sm" type="button" variant="ghost">Skip</Button>
        </div>
      )}
      <div aria-live="polite" className={styles.outcome} role="status">
        {outcome && <><Icon aria-hidden="true" /> <SetupText text={outcome.status === "skipped" ? "Skipped" : outcome.line} /></>}
      </div>
    </li>
  );
}

export function SetupQuestions({ questions, learning, reply, skipAll }: {
  questions: readonly MachineSetupQuestion[];
  learning: boolean;
  reply: (id: string, choice: string) => void;
  skipAll: () => void;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const waiting = questions.filter(({ outcome }) => !outcome).length;
  if (!questions.length) return null;

  return (
    <section aria-labelledby={id} className={styles.section}>
      <header className={styles.questionsHeader}>
        <div>
          <h2 id={id} ref={heading} tabIndex={-1}>
            {waiting > 0 ? `${waiting} quick ${waiting === 1 ? "question" : "questions"}` : "Setup questions"}
          </h2>
          {waiting > 0 && <p>{learning ? "You can answer these while learn deeper runs." : "Only you can answer these."}</p>}
        </div>
        {waiting > 1 && (
          <Button onClick={() => { heading.current?.focus({ preventScroll: true }); skipAll(); }} size="sm" type="button" variant="outline">
            Skip all
          </Button>
        )}
      </header>
      <ol className={styles.questions} role="list">
        {questions.map((question) => <Question key={question.id} question={question} reply={(choice) => reply(question.id, choice)} />)}
      </ol>
    </section>
  );
}
