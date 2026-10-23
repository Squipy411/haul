import { SERVICES, SERVICE_INFO, SERVICE_NAMES } from '../../../shared/services';
import type { DebridService } from '../../../shared/types';

/** TorBox, Real-Debrid, AllDebrid or Premiumize: what each is good at, one to pick. */
export function ServicePicker({ value, onChange, configured }: { value: DebridService; onChange: (service: DebridService) => void; configured?: Partial<Record<DebridService, boolean>> }) {
  return (
    <div className="choice-list service-list" role="radiogroup" aria-label="Debrid service">
      {SERVICES.map((service) => (
        <button key={service} type="button" role="radio" aria-checked={value === service} className="choice" onClick={() => onChange(service)}>
          <span className="choice-dot" aria-hidden="true" />
          <span>
            <b>{SERVICE_NAMES[service]}{configured?.[service] && value !== service ? <span className="faint" style={{ fontWeight: 400 }}> · key saved</span> : null}</b>
            <small>{SERVICE_INFO[service].note}</small>
          </span>
        </button>
      ))}
    </div>
  );
}
