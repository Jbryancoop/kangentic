import type { AppConfig } from '../../../../shared/types';
import { SettingRow, ToggleSwitch, INPUT_CLASS, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

export function BrowserTab({ config }: { config: AppConfig }) {
  const updateProject = useScopedUpdate('project');
  const browserConfig = config.browser ?? {};
  const enabled = browserConfig.enabled !== false;

  return (
    <>
      <SettingRow {...settingProps('browser.enabled')}>
        <ToggleSwitch
          checked={enabled}
          onChange={(value) => updateProject({ browser: { enabled: value } })}
        />
      </SettingRow>
      <SettingRow {...settingProps('browser.defaultUrl')}>
        <input
          type="text"
          value={browserConfig.defaultUrl ?? ''}
          onChange={(event) => {
            // Persist empty string (not undefined) when cleared. deepMergeConfig
            // skips `undefined` values (object-utils.ts:94), so passing
            // `undefined` would be a no-op and leave the existing value in
            // the persisted overrides. Empty string survives the merge, and
            // useBrowserUrl's `||` fallthrough treats it as "no default".
            updateProject({ browser: { defaultUrl: event.target.value.trim() } });
          }}
          placeholder="http://localhost:5173"
          className={`${INPUT_CLASS} placeholder-fg-faint`}
          disabled={!enabled}
        />
      </SettingRow>
    </>
  );
}
