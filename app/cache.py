"""Byte-aware LRU for bounded, JSON-shaped judgment payloads."""

from collections import OrderedDict
import sys


def owned_bytes(value):
    seen = set()

    def size(item):
        if id(item) in seen:
            return 0
        seen.add(id(item))
        total = sys.getsizeof(item)
        if isinstance(item, dict):
            total += sum(size(k) + size(v) for k, v in item.items())
        elif isinstance(item, (list, tuple, set)):
            total += sum(size(v) for v in item)
        return total

    return size(value)


class ByteLRU(OrderedDict):
    def __init__(self, max_entries=512, max_bytes=8 * 1024**2):
        super().__init__()
        self.max_entries, self.max_bytes = max_entries, max_bytes
        self.sizes, self.bytes = {}, 0

    def __setitem__(self, key, value):
        if key in self:
            self.__delitem__(key)
        super().__setitem__(key, value)
        self.sizes[key] = owned_bytes(key) + owned_bytes(value)
        self.bytes += self.sizes[key]
        while len(self) > self.max_entries or self.bytes > self.max_bytes:
            self.popitem(last=False)

    def __delitem__(self, key):
        super().__delitem__(key)
        self.bytes -= self.sizes.pop(key)

    def popitem(self, last=True):
        key, value = super().popitem(last=last)
        self.bytes -= self.sizes.pop(key)
        return key, value

    def clear(self):
        super().clear()
        self.sizes.clear()
        self.bytes = 0
