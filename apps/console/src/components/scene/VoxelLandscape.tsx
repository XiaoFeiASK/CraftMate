interface BirchTreeProps {
  readonly x: number;
  readonly y: number;
  readonly scale?: number;
  readonly reflected?: boolean;
}

export function VoxelLandscape(): React.JSX.Element {
  return (
    <svg className="landscape" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" role="img" aria-label="方块风格的海岸、湖泊与白桦林">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#63aef1" />
          <stop offset=".55" stopColor="#9bd1f7" />
          <stop offset="1" stopColor="#d9eefd" />
        </linearGradient>
        <linearGradient id="water" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#78c7e5" />
          <stop offset=".46" stopColor="#3a9dcc" />
          <stop offset="1" stopColor="#1f6ca7" />
        </linearGradient>
        <linearGradient id="sunhaze" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff9dd" stopOpacity=".82" />
          <stop offset="1" stopColor="#fff9dd" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="reflection" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#edfaff" stopOpacity=".46" />
          <stop offset="1" stopColor="#edfaff" stopOpacity="0" />
        </linearGradient>
        <pattern id="water-grid" width="72" height="44" patternUnits="userSpaceOnUse">
          <path d="M0 22h72M36 0v44" fill="none" stroke="#d9f5ff" strokeOpacity=".08" strokeWidth="1.2" />
        </pattern>
        <filter id="scene-blur">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>

      <rect width="1440" height="900" fill="url(#sky)" />
      <ellipse cx="1030" cy="160" rx="420" ry="260" fill="url(#sunhaze)" />
      <Cloud x={170} y={152} scale={1.22} opacity={0.92} />
      <Cloud x={560} y={82} scale={0.62} opacity={0.72} />
      <Cloud x={1090} y={76} scale={1.08} opacity={0.88} />

      <path fill="#8dbfd9" d="M0 432 64 410l48 11 34-32 59 15 41-34 63 8 53-42 51 32 54-13 41 27 67-8 57 28 57-11 50 24 46-10 60 28 52-22 54 24 53-38 47 20 52-8 31 19v301H0z" />
      <path fill="#6ba6c6" d="M0 478 50 464l44 10 48-24 44 18 42-14 57 15 46-19 67 20 57-13 43 14 72-8 48 20 63-9 58 24 46-15 56 29 53-14 53 19 67-11 43 16 47-8 42 14v273H0z" />
      <path fill="#4c91b5" d="M0 518 56 505l53 12 61-22 47 20 69-16 55 14 70-20 66 21 54-11 58 16 64-11 52 18 64-14 55 20 52-8 51 15 63-8 61 16 53-9 36 11v332H0z" />

      <g filter="url(#scene-blur)" opacity=".24">
        <rect x="694" y="462" width="520" height="54" fill="#e7f7fb" />
      </g>

      <path fill="#59b5d8" d="M0 574h1440v326H0z" />
      <rect y="574" width="1440" height="326" fill="url(#water)" />
      <rect y="574" width="1440" height="326" fill="url(#water-grid)" />
      <path fill="#a6e2f0" fillOpacity=".32" d="M0 598h1440v18H0zM86 650h281v12H86zM463 707h412v15H463zM1040 646h288v12h-288zM242 803h400v18H242z" />

      <g opacity=".28" filter="url(#scene-blur)">
        <path fill="#6f5696" d="M974 606h160v86H974zM1118 624h95v56h-95z" />
        <path fill="#f2eee4" d="M1189 640h27v102h-27zM1032 633h20v80h-20zM1084 619h17v62h-17z" />
      </g>

      <g className="landscape__far-cliff">
        <path fill="#6e8b8e" d="M1134 399h66v-28h46v31h44v-20h42v29h41v-17h67v222h-306z" />
        <path fill="#537a7e" d="M1134 443h69v-28h49v33h44v-19h43v31h41v-18h67v184h-313z" />
        <path fill="#8fa3a2" d="M1134 399h66v-28h46v31h44v-20h42v29h41v-17h67v22h-306z" />
      </g>

      <g className="landscape__island">
        <path fill="#698e55" d="M679 565h428v25H679z" />
        <path fill="#4e713f" d="M679 590h428v23H679z" />
        <path fill="#b6a77c" d="M679 613h428v17H679z" />
        <path fill="#a18f66" d="M679 630h428v19H679z" />
        <path fill="#416b3f" d="M650 565h36l30-15 32 3 20 12zM1038 565h71l33 13v12h-104z" />
      </g>

      <g className="landscape__shore">
        <path fill="#87b95f" d="M0 590h250v24H0zM0 614h330v30H0zM0 644h454v52H0z" />
        <path fill="#6a954e" d="M0 668h454v31H0zM0 699h410v50H0z" />
        <path fill="#9f8f65" d="M0 749h391v82H0zM0 831h304v69H0z" />
        <path fill="#8b7c58" d="M0 799h267v101H0z" />
        <path fill="#b2a275" d="M296 749h95v34h-95zM391 749h35v58h-35zM304 831h72v34h-72z" />
        <path fill="#739b52" d="M370 704h73v27h-73zM438 693h54v35h-54z" />
      </g>

      <g className="landscape__trees">
        <BirchTree x={905} y={300} scale={1.18} />
        <BirchTree x={1016} y={345} scale={.9} />
        <BirchTree x={1094} y={384} scale={.64} />
        <BirchTree x={809} y={395} scale={.55} reflected />
      </g>

      <g className="landscape__reeds">
        <path stroke="#2f6f4d" strokeWidth="5" d="M332 647v-42M350 650v-57M370 647v-32M432 668v-58M454 667v-31" />
        <path fill="#417d51" d="M324 605h14l-7-16zM341 592h15l-7-17zM424 610h15l-7-18z" />
      </g>

      <g className="landscape__glints">
        <path fill="#e9fbff" fillOpacity=".54" d="M529 716h190v10H529zM718 752h122v8H718zM868 665h216v9H868zM1062 806h192v12h-192z" />
        <path fill="#d6f7ff" fillOpacity=".38" d="M690 617h118v12H690zM604 845h305v18H604z" />
      </g>

      <g className="landscape__blocks">
        <path fill="#467b46" d="m369 713 29-16 29 16v26l-29 16-29-16z" />
        <path fill="#68a75b" d="m398 697 29 16-29 16-29-16z" />
        <path fill="#326c49" d="m398 729 29-16v26l-29 16z" />
        <path fill="#9a8a62" d="m74 774 42-22 42 22v37l-42 23-42-23z" />
        <path fill="#c5b789" d="m116 752 42 22-42 23-42-23z" />
        <path fill="#756849" d="m116 797 42-23v37l-42 23z" />
      </g>

      <rect width="1440" height="900" fill="none" stroke="#ffffff" strokeOpacity=".22" strokeWidth="2" />
    </svg>
  );
}

function BirchTree({ x, y, scale = 1, reflected = false }: BirchTreeProps): React.JSX.Element {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} opacity={reflected ? 0.62 : 1}>
      <path fill="#f5f0d7" d="M30 130h34v170H30z" />
      <path fill="#d9d2b7" d="M64 130h16v170H64z" />
      <path fill="#3b3830" d="M30 151h20v9H30zM53 183h27v8H53zM35 219h21v7H35zM62 251h18v8H62z" />
      <g fill="#4f9d3c">
        <path d="M-4 98h28v31H-4zM20 68h52v34H20zM67 54h47v39H67zM107 75h35v41h-35zM23 98h129v34H23zM6 127h81v28H6zM73 122h83v32H73z" />
      </g>
      <g fill="#70bf4e">
        <path d="M22 77h46v20H22zM78 63h33v22H78zM110 85h27v23h-27zM40 101h95v20H40zM16 129h69v15H16zM83 123h64v22H83z" />
      </g>
      <g fill="#3a7e32">
        <path d="M31 112h103v12H31zM10 145h70v10H10zM87 139h73v13H87zM54 88h72v12H54z" />
      </g>
    </g>
  );
}

interface CloudProps {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly opacity: number;
}

function Cloud({ x, y, scale, opacity }: CloudProps): React.JSX.Element {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} opacity={opacity} className="landscape__cloud">
      <path fill="#f8fcff" d="M0 44h35V24h55V7h86v17h63v20h52v26H0z" />
      <path fill="#dceef9" d="M0 70h291v18H0zM35 44h256v13H35z" />
      <path fill="#ffffff" fillOpacity=".4" d="M55 24h86v12H55zM141 7h35v17h-35z" />
    </g>
  );
}
