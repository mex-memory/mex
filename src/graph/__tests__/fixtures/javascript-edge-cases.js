import { api } from "./api.js";

// IIFE to test containment and calls
(function init() {
  api.setup();
})();

export const utils = {
  // Method in object literal
  format() {
    return "fmt";
  }
};

// Class with static method and private field
export class Manager {
  #internalState = 0;

  static create() {
    return new Manager();
  }

  update() {
    this.#internalState++;
    api.save(this.#internalState);
  }
}

// Ambiguous or unsupported syntax that degrades safely
function withWeirdSyntax() {
  const x = ; // missing value
  return x;
}
