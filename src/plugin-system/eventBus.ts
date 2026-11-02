/**
 * 主进程内核事件总线。
 *
 * 订阅按插件归属保存，卸载时可以一次清理，避免插件留下监听器。
 */
export class EventBus<M extends object> {
  private readonly listeners = new Map<keyof M, Array<{
    owner: string | null;
    callback: (payload: unknown) => void;
  }>>();

  on<K extends keyof M>(
    event: K,
    callback: (payload: M[K]) => void,
    owner: string | null = null,
  ): void {
    const listeners = this.listeners.get(event) ?? [];
    if (!listeners.some((entry) => entry.owner === owner && entry.callback === callback)) {
      listeners.push({ owner, callback: callback as (payload: unknown) => void });
    }
    this.listeners.set(event, listeners);
  }

  emit<K extends keyof M>(event: K, payload: M[K]): void {
    this.dispatch(event, payload, null);
  }

  emitTo<K extends keyof M>(owner: string, event: K, payload: M[K]): void {
    this.dispatch(event, payload, owner);
  }

  offOwner(owner: string): void {
    for (const [event, listeners] of this.listeners) {
      const remaining = listeners.filter((entry) => entry.owner !== owner);
      if (remaining.length) this.listeners.set(event, remaining);
      else this.listeners.delete(event);
    }
  }

  private dispatch<K extends keyof M>(event: K, payload: M[K], owner: string | null): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;

    for (const entry of [...listeners]) {
      if (owner !== null && entry.owner !== owner) continue;
      try {
        entry.callback(payload);
      } catch (error) {
        console.error(`[plugin] 事件 "${String(event)}" 的订阅者抛错（已隔离）：`, error);
      }
    }
  }
}
