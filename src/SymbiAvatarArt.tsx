import { useId } from 'react';

export type SymbiState = 'idle' | 'thinking' | 'searching' | 'reading' | 'working' | 'navigating' | 'tooling' | 'speaking' | 'done' | 'error'
  | 'jev-routing' | 'jev-analyzing' | 'jev-verifying' | 'jev-applying';

export function SymbiAvatar({ state = 'idle', size = 'medium', decorative = false }: { state?: SymbiState; size?: 'small' | 'medium' | 'large'; decorative?: boolean }) {
  const gradientId = useId();
  const gradient = (name: string) => `url(#${gradientId}-${name})`;
  return <span className={`symbi-avatar symbi-avatar--${size} symbi-avatar--${state}`}
    role={decorative ? undefined : 'img'} aria-hidden={decorative || undefined}
    aria-label={decorative ? undefined : `Symbi ${state.replace('jev-', 'Jev ')}`}>
    <svg viewBox={size === 'large' ? '0 0 100 112' : '0 0 100 91'} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${gradientId}-shell`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#426473"/><stop offset=".45" stopColor="#203b49"/><stop offset="1" stopColor="#102733"/></linearGradient>
        <linearGradient id={`${gradientId}-screen`} x1="0" y1="0" x2=".9" y2="1"><stop stopColor="#203b49"/><stop offset="1" stopColor="#091b25"/></linearGradient>
        <linearGradient id={`${gradientId}-coral`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#ffb28e"/><stop offset="1" stopColor="#e87859"/></linearGradient>
        <linearGradient id={`${gradientId}-blue`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#a2b1ff"/><stop offset="1" stopColor="#6377ed"/></linearGradient>
        <linearGradient id={`${gradientId}-mint`} x1=".1" y1="0" x2=".9" y2="1"><stop stopColor="#dcffe4"/><stop offset="1" stopColor="#73dcad"/></linearGradient>
        <linearGradient id={`${gradientId}-suit`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fffefa"/><stop offset="1" stopColor="#d1dcd9"/></linearGradient>
      </defs>
      <g className="symbi-avatar__body">
        <path d="M39 74H61V91H39Z" fill={gradient('shell')}/>
        <path d="M15 110C15 91 28 83 40 82L50 94L60 82C72 83 85 91 85 110Z" fill={gradient('suit')} stroke="#9bafad" strokeWidth="1.4"/>
        <path d="M39 82L50 96L61 82L59 76H41Z" fill={gradient('shell')}/>
        <path d="M50 91L55 96L50 101L45 96Z" fill={gradient('mint')} stroke="#4fae82" strokeWidth="1.2" className="symbi-avatar__chest"/>
        <path className="symbi-avatar__arm symbi-avatar__arm--left" d="M15 91Q10 94 7 106L24 110Q27 97 31 89Z" fill={gradient('coral')} stroke="#be614b" strokeWidth="1.2"/>
        <path className="symbi-avatar__arm symbi-avatar__arm--right" d="M85 91Q90 94 93 106L76 110Q73 97 69 89Z" fill={gradient('blue')} stroke="#5267bd" strokeWidth="1.2"/>
      </g>
      <g className="symbi-avatar__head">
        <g className="symbi-avatar__antenna">
          <path d="M47 24L48 14H52L53 24Z" fill={gradient('shell')}/>
          <circle className="symbi-avatar__antenna-light" cx="50" cy="9" r="6.3" fill={gradient('mint')} stroke="#7fe8b7" strokeWidth="1.2"/>
        </g>
        <path d="M15 36C9 40 6 49 7 59C7 68 10 75 16 79L27 70L27 36Z" fill={gradient('coral')} stroke="#b65d47" strokeWidth="1.3"/>
        <path d="M85 36C91 40 94 49 93 59C93 68 90 75 84 79L73 70L73 36Z" fill={gradient('blue')} stroke="#4e63c3" strokeWidth="1.3"/>
        <rect x="12" y="21" width="76" height="65" rx="27" fill={gradient('shell')} stroke="#496e7b" strokeWidth="1.5"/>
        <path d="M18 45C18 31 29 27 43 27H57C71 27 82 31 82 45" fill="none" stroke="#7795a0" strokeOpacity=".3" strokeWidth="2"/>
        <rect className="symbi-avatar__screen" x="17" y="29" width="66" height="49" rx="21" fill={gradient('screen')} stroke="#091b25" strokeWidth="2"/>
        <path d="M22 39C26 33 34 31 43 31H57" fill="none" stroke="#a4c9d1" strokeOpacity=".15" strokeWidth="1.6" strokeLinecap="round"/>
        <rect x="6" y="47" width="9" height="25" rx="4.5" fill={gradient('coral')} stroke="#13313b" strokeWidth="2"/>
        <rect x="85" y="47" width="9" height="25" rx="4.5" fill={gradient('blue')} stroke="#13313b" strokeWidth="2"/>
        <rect className="symbi-avatar__ear-light symbi-avatar__ear-light--left" x="8.6" y="52" width="3.7" height="15" rx="1.9" fill="#24404b"/>
        <rect className="symbi-avatar__ear-light symbi-avatar__ear-light--right" x="87.6" y="52" width="3.7" height="15" rx="1.9" fill="#24404b"/>
        <g className="symbi-avatar__eyes symbi-avatar__eyes--smile" fill="none" stroke={gradient('mint')} strokeWidth="4.5" strokeLinecap="round">
          <path d="M30 54Q36 44 42 54"/><path d="M58 54Q64 44 70 54"/>
        </g>
        <g className="symbi-avatar__eyes symbi-avatar__eyes--focus" fill={gradient('mint')}>
          <ellipse cx="36" cy="51" rx="3" ry="4.4"/><ellipse cx="64" cy="51" rx="3" ry="4.4"/>
        </g>
        <g className="symbi-avatar__eyes symbi-avatar__eyes--error" fill="none" stroke="#f4ac9b" strokeWidth="3.4" strokeLinecap="round">
          <path d="M32 48L40 55M40 48L32 55M60 48L68 55M68 48L60 55"/>
        </g>
        <path className="symbi-avatar__mouth symbi-avatar__mouth--smile" d="M44 64Q50 69 56 64" fill="none" stroke={gradient('mint')} strokeWidth="3.8" strokeLinecap="round"/>
        <ellipse className="symbi-avatar__mouth symbi-avatar__mouth--talk" cx="50" cy="65" rx="4.2" ry="5" fill={gradient('mint')}/>
        <path className="symbi-avatar__mouth symbi-avatar__mouth--flat" d="M45 66H55" fill="none" stroke={gradient('mint')} strokeWidth="3.4" strokeLinecap="round"/>
        <circle className="symbi-avatar__cheek symbi-avatar__cheek--left" cx="27" cy="62" r="3" fill="#ef906f"/>
        <circle className="symbi-avatar__cheek symbi-avatar__cheek--right" cx="73" cy="62" r="3" fill="#738af1"/>
        <path className="symbi-avatar__scan" d="M23 40H77" fill="none" stroke="#9cf3c0" strokeOpacity=".75" strokeWidth="1.5" strokeLinecap="round"/>
        <g className="symbi-avatar__read-lines" fill="none" stroke="#9cf3c0" strokeWidth="2" strokeLinecap="round"><path d="M35 63H65"/><path d="M39 68H61"/></g>
      </g>
      <g className="symbi-avatar__thoughts" fill="#bce7c9"><circle cx="16" cy="26" r="2.3"/><circle cx="11" cy="19" r="1.6"/><circle cx="7" cy="13" r="1"/></g>
      <circle className="symbi-avatar__search-orbit" cx="50" cy="52" r="42" fill="none" stroke="#9cf3c0" strokeWidth="2" strokeDasharray="11 252" strokeLinecap="round"/>
      <g className="symbi-avatar__work-sparks" fill="none" stroke="#bce7c9" strokeWidth="2" strokeLinecap="round"><path d="M6 31v8M2 35h8"/><path d="M94 25v8M90 29h8"/></g>
      <path className="symbi-avatar__navigate-arrow" d="M90 31l6 6-6 6" fill="none" stroke="#bce7c9" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round"/>
      <g className="symbi-avatar__tool-gear" fill="none" stroke="#bce7c9" strokeWidth="1.8" strokeLinecap="round"><circle cx="89" cy="20" r="5"/><path d="M89 11v3M89 26v3M80 20h3M95 20h3M82.5 13.5l2.2 2.2M93.3 24.3l2.2 2.2"/></g>
      <g className="symbi-avatar__signal" fill="none" stroke="#a7efc2" strokeWidth="1.5" strokeLinecap="round">
        <path d="M40 9A10 10 0 0 0 38 14"/><path d="M60 9A10 10 0 0 1 62 14"/>
      </g>
    </svg>
  </span>;
}
