type ConsoleMethod = "warn" | "error" | "log" | "info";

type ConsoleSpy<M extends ConsoleMethod> = Record<
  M,
  ReturnType<typeof jest.spyOn>
> & {
  [Symbol.dispose](): void;
};

export function spyOnConsole<M extends ConsoleMethod>(method: M): ConsoleSpy<M> {
  const spy = jest.spyOn(console, method).mockImplementation(() => {});

  return {
    [method]: spy,
    [Symbol.dispose]() {
      spy.mockRestore();
    },
  } as ConsoleSpy<M>;
}

