import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  LoaderCircle,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { api } from "../../shared/api/client";
import type {
  AgentModel,
  AgentProvider,
} from "../../shared/api/contracts.generated";

const preferenceKey = "symbiknow.assistant.preferences";
type Preference = {
  provider?: string;
  models?: Record<string, { model: string; effort: string }>;
};
function preferences(): Preference {
  try {
    return JSON.parse(localStorage.getItem(preferenceKey) || "{}") || {};
  } catch {
    return {};
  }
}

export function rememberModel(provider: string, model: string, effort: string) {
  try {
    localStorage.setItem(
      preferenceKey,
      JSON.stringify({
        provider,
        models: { ...preferences().models, [provider]: { model, effort } },
      }),
    );
  } catch {
    /* A private browser may disable preference storage. */
  }
}

export function ModelPicker({
  providers,
  providerLoading,
  providerError,
  retryProviders,
  connecting,
  choose,
}: {
  providers: AgentProvider[];
  providerLoading: boolean;
  providerError: string;
  retryProviders: () => void;
  connecting: boolean;
  choose: (provider: string, model: string, effort: string) => void;
}) {
  const [provider, setProvider] = useState("");
  const [models, setModels] = useState<AgentModel[]>([]);
  const [model, setModel] = useState(""),
    [effort, setEffort] = useState("");
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    if (provider) return;
    const saved = preferences().provider;
    setProvider(
      providers.find((p) => p.available && p.id === saved)?.id ||
        providers.find((p) => p.available)?.id ||
        "",
    );
  }, [providers, provider]);
  useEffect(() => {
    if (!provider) return;
    const current = ++generation.current;
    const abort = new AbortController();
    setLoading(true);
    setModels([]);
    setModel("");
    setError("");
    api<{ models: AgentModel[] }>(
      "agent-models",
      { provider, refresh: refresh > 0 },
      abort.signal,
    )
      .then(({ models }) => {
        if (current !== generation.current || abort.signal.aborted) return;
        const saved = preferences().models?.[provider];
        const selected =
          models.find((m) => m.id === saved?.model) ||
          models.find((m) => m.default) ||
          models[0];
        setModels(models);
        setModel(selected?.id || "");
        setEffort(
          selected?.efforts.includes(saved?.effort || "")
            ? saved!.effort
            : selected?.default_effort || "",
        );
      })
      .catch((error) => {
        if (!abort.signal.aborted && current === generation.current)
          setError(String(error));
      })
      .finally(() => {
        if (!abort.signal.aborted && current === generation.current)
          setLoading(false);
      });
    return () => abort.abort();
  }, [provider, refresh]);
  const selected = models.find((m) => m.id === model);
  return (
    <form
      className="assistant-picker"
      onSubmit={(e) => {
        e.preventDefault();
        if (selected && !loading && !connecting)
          choose(provider, model, effort);
      }}
    >
      <div className="assistant-picker-intro">
        <span className="assistant-emblem">
          <Sparkles size={22} />
        </span>
        <h2>Your library, in conversation.</h2>
        <p>Find answers, follow the evidence, and make changes together.</p>
      </div>
      <fieldset disabled={connecting}>
        <legend>1 · Choose your agent</legend>
        <div className="assistant-providers">
          {providers.filter((p) => p.available).map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={!p.available}
              aria-pressed={provider === p.id}
              onClick={() => setProvider(p.id)}
              title={p.version}
            >
              <span
                className={`assistant-provider-mark ${p.id}`}
                aria-hidden="true"
              >
                {p.name.slice(0, 1)}
              </span>
              <span>
                <strong>{p.name}</strong>
                <small>
                  {p.available ? "Ready · Your CLI login" : p.reason}
                </small>
              </span>
              {provider === p.id && <Check size={16} />}
            </button>
          ))}
        </div>
        {providers.some((p) => !p.available) && (
          <details className="assistant-unavailable">
            <summary>
              Unavailable ({providers.filter((p) => !p.available).length})
            </summary>
            <div className="assistant-providers">
          {providers.filter((p) => !p.available).map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={!p.available}
              aria-pressed={provider === p.id}
              onClick={() => setProvider(p.id)}
              title={p.version}
            >
              <span
                className={`assistant-provider-mark ${p.id}`}
                aria-hidden="true"
              >
                {p.name.slice(0, 1)}
              </span>
              <span>
                <strong>{p.name}</strong>
                <small>
                  {p.available ? "Ready · Your CLI login" : p.reason}
                </small>
              </span>
              {provider === p.id && <Check size={16} />}
            </button>
          ))}
            </div>
          </details>
        )}
        {providerLoading && (
          <p className="assistant-muted" role="status">
            <LoaderCircle className="assistant-spin" size={14} aria-hidden="true" /> Checking installed agents…
          </p>
        )}
        {!providerLoading && providerError && (
          <div role="alert" className="assistant-inline-error">
            <p>{providerError}</p>
            <button
              type="button"
              className="assistant-text-button"
              onClick={retryProviders}
            >
              Retry agent discovery
            </button>
          </div>
        )}
        {!providerLoading && !providerError && !providers.length && (
          <p className="assistant-muted">
            No agents found. Install and sign in to a supported CLI, then{" "}
            <button
              type="button"
              className="assistant-text-button"
              onClick={retryProviders}
            >
              Retry agent discovery
            </button>
            .
          </p>
        )}
      </fieldset>
      {provider && (
        <fieldset disabled={connecting || loading}>
          <legend>2 · Choose your model</legend>
          <div className="assistant-model-label">
            <label htmlFor="assistant-model">Model</label>
            <button
              type="button"
              className="assistant-text-button"
              disabled={loading || connecting}
              onClick={() => setRefresh((n) => n + 1)}
              aria-label="Refresh models"
            >
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
          {loading ? (
            <p className="assistant-models-loading" role="status">
              <LoaderCircle className="assistant-spin" size={16} /> Reading
              models from your CLI…
            </p>
          ) : (
            <>
              <select
                id="assistant-model"
                value={model}
                disabled={!models.length}
                onChange={(e) => {
                  setModel(e.target.value);
                  setEffort(
                    models.find((m) => m.id === e.target.value)
                      ?.default_effort || "",
                  );
                }}
              >
                {!models.length && <option value="">No models loaded</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.default ? " · Default" : ""}
                  </option>
                ))}
              </select>
              {selected && (
                <p className="assistant-model-description">
                  {selected.description}
                </p>
              )}
              {!!selected?.efforts.length && (
                <div className="assistant-effort">
                  <label htmlFor="assistant-effort">
                    <SlidersHorizontal size={14} /> Reasoning effort
                  </label>
                  <select
                    id="assistant-effort"
                    value={effort}
                    onChange={(e) => setEffort(e.target.value)}
                  >
                    <option value="">CLI default</option>
                    {selected.efforts.map((value) => (
                      <option key={value} value={value}>
                        {value === "xhigh"
                          ? "Extra high"
                          : value[0].toUpperCase() + value.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}
          {error && (
            <p className="assistant-inline-error" role="alert">
              {error}
            </p>
          )}
        </fieldset>
      )}
      <div className="assistant-picker-footer">
      <button
        className="assistant-primary assistant-connect"
        type="submit"
        disabled={!selected || loading || connecting}
      >
        {connecting ? (
          <>
            <LoaderCircle size={16} className="assistant-spin" /> Connecting…
          </>
        ) : (
          <>
            Start chat <ArrowRight size={16} />
          </>
        )}
      </button>
      <p className="assistant-picker-note">
        Uses your installed CLI and account. Library changes always ask for your
        approval.
      </p>
      </div>
    </form>
  );
}
