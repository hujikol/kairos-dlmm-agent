if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = (value) => {
    if (value === undefined || value === null) return value;
    return JSON.parse(JSON.stringify(value));
  };
}
