"""Small strict validator for the registry's JSON-schema subset."""


def validate(value, schema, path="arguments"):
    kind = schema.get("type")
    types = {"object": dict, "array": list, "string": str, "integer": int, "boolean": bool}
    if kind in types and type(value) is not types[kind]:
        raise ValueError(f"{path} must be {kind}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path} is not a supported choice")
    if kind == "object":
        properties = schema.get("properties", {})
        if set(value) - properties.keys() or set(schema.get("required", [])) - value.keys():
            raise ValueError(f"{path} has missing or unknown fields")
        for key, item in value.items():
            validate(item, properties[key], path + "." + key)
    if kind == "array":
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 100):
            raise ValueError(f"{path} has too many or too few items")
        for item in value:
            validate(item, schema["items"], path + "[]")
    if kind == "string" and not schema.get("minLength", 0) <= len(value) <= schema.get(
        "maxLength", 32000
    ):
        raise ValueError(f"{path} has an invalid length")
    if kind == "integer" and not schema.get("minimum", 0) <= value <= schema.get("maximum", 2**31):
        raise ValueError(f"{path} is out of range")
