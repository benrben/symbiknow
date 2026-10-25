"""Bounded, session-local browser requests. Product handlers live in the browser."""

import asyncio
import uuid
import time


class UIBridge:
    def __init__(self, emit, connected, timeout=15):
        self.emit, self.connected, self.timeout = emit, connected, timeout
        self.pending = {}

    async def call(self, name, args, run_id):
        if not self.connected():
            return {"ok": False, "reason": "no_ui"}
        if len(self.pending) >= 16:
            return {"ok": False, "reason": "user_busy"}
        identity = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.pending[identity] = future
        try:
            await self.emit(
                "ui_command",
                run_id=run_id,
                id=identity,
                name=name,
                args=args,
                expires_at=int((time.time() + self.timeout) * 1000),
            )
            return await asyncio.wait_for(future, self.timeout)
        except TimeoutError:
            return {"ok": False, "reason": "timeout"}
        finally:
            self.pending.pop(identity, None)

    def resolve(self, identity, ok, result):
        future = self.pending.get(identity)
        if not future or future.done():
            return False
        future.set_result({"ok": ok, "result": result})
        return True

    def cancel(self, reason="cancelled"):
        for future in list(self.pending.values()):
            if not future.done():
                future.set_result({"ok": False, "reason": reason})
