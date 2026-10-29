import { terminalQuestion } from "../../dist/terminal.js";
try {
  const value = await terminalQuestion("Private token: ", true);
  console.log("Received " + value.length + " characters");
} catch (error) {
  console.log(error.code);
  process.exitCode = 2;
}
