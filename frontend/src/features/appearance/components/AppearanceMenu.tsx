import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, Moon, Sun, Monitor } from "lucide-react";
import { useAppearance, type Appearance } from "../preferences";

export default function AppearanceMenu() {
  const { mode, theme, setAppearance } = useAppearance();
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          className="icon"
          aria-label="Appearance"
          title={`Theme: ${mode === "system" ? "System" : mode === "dark" ? "Dark" : "Light"} · Click to change`}
        >
          {theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu appearance-menu" align="end">
          <Menu.Label className="menu-label">Appearance</Menu.Label>
          <Menu.RadioGroup
            value={mode}
            onValueChange={(value) => setAppearance(value as Appearance)}
          >
            {(
              [
                ["dark", "Dark", Moon],
                ["light", "Light", Sun],
                ["system", "System", Monitor],
              ] as const
            ).map(([value, label, Icon]) => (
              <Menu.RadioItem key={value} value={value}>
                <Icon size={15} />
                <span>{label}</span>
                <Menu.ItemIndicator>
                  <Check size={14} />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
