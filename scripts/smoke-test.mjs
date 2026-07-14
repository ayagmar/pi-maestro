import("./../src/index.ts")
  .then((mod) => {
    if (typeof mod.default !== "function") throw new Error("Default export is not a function");

    const toolNames = [];
    const pi = new Proxy(
      {
        registerTool(tool) {
          toolNames.push(tool.name);
        },
      },
      {
        get(target, property) {
          if (property in target) return target[property];
          return () => {};
        },
      }
    );
    mod.default(pi);
    const expected = ["maestro_drive", "maestro_plan", "maestro_update"];
    if (JSON.stringify([...toolNames].sort()) !== JSON.stringify(expected)) {
      throw new Error(`Expected exactly ${expected.join(", ")}; received ${toolNames.join(", ")}`);
    }
    console.log("✓ Extension loads and registers exactly three model tools");
  })
  .catch((error) => {
    console.error("✗ Extension failed to load:", error);
    process.exitCode = 1;
  });
