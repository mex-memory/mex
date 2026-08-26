/**
 * Product illustration for the empty state — wiki, graph, and drift as one
 * composed graphic so the welcome screen has a landing-page visual without
 * shipping an image asset.
 */
export function WelcomeArt() {
  return (
    <svg
      className="welcome-art"
      viewBox="0 0 420 360"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="wa-glow" cx="58%" cy="42%" r="52%">
          <stop offset="0%" stopColor="#e8845c" stopOpacity="0.22" />
          <stop offset="55%" stopColor="#e8845c" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#e8845c" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="wa-panel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#171a20" />
          <stop offset="100%" stopColor="#121419" />
        </linearGradient>
        <linearGradient id="wa-accent" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#e8845c" />
          <stop offset="100%" stopColor="#c8613c" />
        </linearGradient>
      </defs>

      <circle className="welcome-art__glow" cx="240" cy="150" r="150" fill="url(#wa-glow)" />

      {/* Wiki panel */}
      <g className="welcome-art__wiki">
        <rect x="28" y="78" width="132" height="168" rx="14" fill="url(#wa-panel)" stroke="#313641" />
        <rect x="28" y="78" width="132" height="36" rx="14" fill="#1c1f27" />
        <rect x="28" y="98" width="132" height="16" fill="#1c1f27" />
        <circle cx="46" cy="96" r="3.5" fill="#e5675f" />
        <circle cx="58" cy="96" r="3.5" fill="#e2b14f" />
        <circle cx="70" cy="96" r="3.5" fill="#5fbf7f" />
        <text x="84" y="100" fill="#9aa1ad" fontSize="10" fontFamily="ui-monospace, monospace">
          .mex/
        </text>
        <rect x="44" y="128" width="72" height="7" rx="3.5" fill="#e8845c" fillOpacity="0.55" />
        <rect x="44" y="146" width="100" height="5" rx="2.5" fill="#313641" />
        <rect x="44" y="160" width="88" height="5" rx="2.5" fill="#313641" />
        <rect x="44" y="174" width="96" height="5" rx="2.5" fill="#313641" />
        <rect x="44" y="198" width="54" height="7" rx="3.5" fill="#6b93f5" fillOpacity="0.45" />
        <rect x="44" y="216" width="100" height="5" rx="2.5" fill="#313641" />
        <rect x="44" y="230" width="76" height="5" rx="2.5" fill="#313641" />
      </g>

      {/* Graph constellation */}
      <g className="welcome-art__graph">
        <line className="welcome-art__edge" x1="198" y1="132" x2="248" y2="98" stroke="#e8845c" strokeOpacity="0.45" strokeWidth="1.4" />
        <line className="welcome-art__edge" x1="248" y1="98" x2="304" y2="128" stroke="#e8845c" strokeOpacity="0.35" strokeWidth="1.4" />
        <line className="welcome-art__edge" x1="198" y1="132" x2="236" y2="178" stroke="#6b93f5" strokeOpacity="0.4" strokeWidth="1.4" />
        <line className="welcome-art__edge" x1="236" y1="178" x2="304" y2="128" stroke="#6b93f5" strokeOpacity="0.3" strokeWidth="1.4" />
        <line className="welcome-art__edge" x1="236" y1="178" x2="278" y2="214" stroke="#5fbf7f" strokeOpacity="0.4" strokeWidth="1.4" />
        <line className="welcome-art__edge" x1="304" y1="128" x2="278" y2="214" stroke="#5fbf7f" strokeOpacity="0.28" strokeWidth="1.4" />
        <line className="welcome-art__edge" x1="160" y1="162" x2="198" y2="132" stroke="#313641" strokeWidth="1.2" strokeDasharray="3 4" />

        <circle className="welcome-art__node welcome-art__node--a" cx="198" cy="132" r="9" fill="#171a20" stroke="#e8845c" strokeWidth="1.8" />
        <circle className="welcome-art__node welcome-art__node--b" cx="248" cy="98" r="7" fill="#171a20" stroke="#e8845c" strokeWidth="1.6" />
        <circle className="welcome-art__node welcome-art__node--c" cx="304" cy="128" r="10" fill="#171a20" stroke="#6b93f5" strokeWidth="1.8" />
        <circle className="welcome-art__node welcome-art__node--d" cx="236" cy="178" r="8" fill="#171a20" stroke="#9aa1ad" strokeWidth="1.5" />
        <circle className="welcome-art__node welcome-art__node--e" cx="278" cy="214" r="7" fill="#171a20" stroke="#5fbf7f" strokeWidth="1.6" />
        <circle cx="198" cy="132" r="2.5" fill="#e8845c" />
        <circle cx="304" cy="128" r="2.5" fill="#6b93f5" />
        <circle cx="278" cy="214" r="2.2" fill="#5fbf7f" />
      </g>

      {/* Drift / health ring */}
      <g className="welcome-art__drift">
        <circle cx="338" cy="268" r="42" fill="#121419" stroke="#23262e" strokeWidth="1" />
        <circle cx="338" cy="268" r="34" stroke="#23262e" strokeWidth="6" fill="none" />
        <circle
          className="welcome-art__ring"
          cx="338"
          cy="268"
          r="34"
          stroke="url(#wa-accent)"
          strokeWidth="6"
          strokeLinecap="round"
          fill="none"
          strokeDasharray="168"
          strokeDashoffset="28"
          transform="rotate(-90 338 268)"
        />
        <text
          x="338"
          y="264"
          textAnchor="middle"
          fill="#e9ebef"
          fontSize="18"
          fontWeight="600"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
        >
          94
        </text>
        <text
          x="338"
          y="282"
          textAnchor="middle"
          fill="#6a7180"
          fontSize="9"
          letterSpacing="0.08em"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
        >
          HEALTH
        </text>
      </g>

      {/* Caption chips */}
      <g className="welcome-art__chips" fontFamily="ui-sans-serif, system-ui, sans-serif">
        <rect x="44" y="268" width="54" height="22" rx="11" fill="#171a20" stroke="#313641" />
        <text x="71" y="283" textAnchor="middle" fill="#9aa1ad" fontSize="10" fontWeight="600">
          wiki
        </text>
        <rect x="198" y="248" width="58" height="22" rx="11" fill="#171a20" stroke="#313641" />
        <text x="227" y="263" textAnchor="middle" fill="#9aa1ad" fontSize="10" fontWeight="600">
          graph
        </text>
      </g>
    </svg>
  );
}
