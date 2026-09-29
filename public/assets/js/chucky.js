/* Chucky, the mascot: the SVG and his greeting lines. Used by the hub and every editor. */
window.Chucky = (function () {
  // stroke and shades take `color`; the body is white
  const SVG = '<svg viewBox="0 0 220 220" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M58 188 C22 188 24 156 48 158" fill="#fff"/>'
    + '<path d="M70 200 C34 200 36 150 60 128 C72 117 78 116 86 112 C104 124 124 124 142 114 C150 119 160 126 168 138 C190 168 178 201 138 200 C116 200 92 200 70 200 Z" fill="#fff"/>'
    + '<path d="M96 199 q6 6 12 0 M120 199 q6 6 12 0" stroke-width="2.4"/>'
    + '<path d="M74 70 L68 30 L94 54 C102 50 118 50 126 56 L152 32 L146 74 C156 96 150 120 110 121 C72 121 64 94 74 70 Z" fill="#fff"/>'
    + '<path d="M139 67 L154 58" stroke-width="3.6"/>'
    + '<rect x="74" y="64" width="32" height="20" fill="currentColor" stroke="none"/>'
    + '<rect x="112" y="62" width="28" height="17" fill="currentColor" stroke="none"/>'
    + '<rect x="103" y="69" width="10" height="5" fill="currentColor" stroke="none"/>'
    + '<rect x="79" y="78" width="6.5" height="4.5" fill="#fff" stroke="none"/>'
    + '<rect x="116" y="74" width="5" height="3.5" fill="#fff" stroke="none"/>'
    + '<path d="M106 95 q5 6 10 1" stroke-width="2.6"/>'
    + '<path d="M80 85 L56 79 M80 90 L54 91 M82 95 L58 103" stroke-width="2.2"/>'
    + '<path d="M150 81 L174 75 M150 86 L176 87 M148 91 L172 99" stroke-width="2.2"/></svg>';

  const GREETINGS = [
    'How can I help you today, you non-skilled human?', "Oh. It's you again. Let's fix this menu.",
    'I brought the shades. You bring the typos.', "Menus don't edit themselves. With me, basically they do.",
    "Try not to break anything. I'm watching. 😎", 'Another day, another menu you need me for.',
    'Point. Click. Let me carry you.', "90% attitude, 10% PDF surgeon. Let's go.",
    'You + me + this menu = unfair advantage.', 'Cleaner. Shorter. Better. Sound familiar?',
    'Cool cats edit fast. Try to keep up.', "I've seen worse menus. Barely.",
    'Ready when you are, slowpoke.', 'I do the hard part. You take the credit.',
    'Sit. Stay. Watch a professional work.', "Hope you brought snacks. This'll take you a while.",
    "Relax, human. The cat's got it.",
  ];

  // A different line on each visit, and a different run of lines each day.
  function greeting() {
    const now = new Date();
    const day = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 86400000);
    let visits = 0;
    try { visits = +(sessionStorage.getItem('chucky_visits') || 0); sessionStorage.setItem('chucky_visits', visits + 1); } catch { /* storage blocked */ }
    const n = GREETINGS.length;
    return GREETINGS[(((day * 5 + visits) % n) + n) % n];
  }

  return { SVG, greeting };
})();
