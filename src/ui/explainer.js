// Collapsible "¿Cómo funciona?" didactic panel — short Spanish sections on the
// traffic models plus suggested experiments. Pure static DOM, built once.

const SECTIONS = [
  {
    title: 'IDM — seguimiento vehicular',
    html:
      'Cada vehículo ajusta su aceleración con el <b>Modelo de Conductor ' +
      'Inteligente</b>:<br>' +
      '<code>a = a<sub>máx</sub>·[1 − (v/v₀)⁴ − (s*/s)²]</code>, con ' +
      '<code>s* = s₀ + v·T + v·Δv / (2√(a·b))</code>.<br>' +
      'Intuición: acelera hacia su velocidad deseada v₀, pero frena cuando el ' +
      'hueco real <code>s</code> con el líder es menor que el hueco deseado ' +
      '<code>s*</code> (que crece con la velocidad y con la rapidez de ' +
      'aproximación Δv). Un solo modelo produce arranques, frenadas y colas ' +
      'realistas.',
  },
  {
    title: 'MOBIL — cambios de carril',
    html:
      'Un vehículo cambia de carril si <b>gana más de lo que hace perder</b>: ' +
      'la mejora de su propia aceleración debe superar a la molestia causada a ' +
      'los seguidores, ponderada por la <b>cortesía p</b> (control en el ' +
      'panel). Con p = 0 los conductores son egoístas; con p = 1, altruistas. ' +
      'Nunca se cambia si el nuevo seguidor tendría que frenar bruscamente ' +
      '(criterio de seguridad).',
  },
  {
    title: 'Semáforos y ondas verdes',
    html:
      'Cada cruce alterna dos fases (eje N-S / eje E-O) con ámbar y todo-rojo ' +
      'de seguridad. Los desfases entre cruces se calculan para que un pelotón ' +
      'que viaja a la <b>velocidad de onda verde</b> encuentre verde tras ' +
      'verde a lo largo del eje principal. Prueba a seguir un vehículo por la ' +
      'avenida y observa la coordinación.',
  },
  {
    title: 'Ondas de choque (stop-and-go)',
    html:
      'Cuando la densidad es alta, una pequeña frenada se <b>amplifica hacia ' +
      'atrás</b>: cada conductor frena un poco más tarde y un poco más fuerte ' +
      'que el de adelante. El resultado es una onda de paradas que viaja ' +
      'contracorriente (~15–20 km/h hacia atrás) aunque ningún obstáculo ' +
      'exista ya. Es el clásico atasco fantasma.',
  },
  {
    title: 'Diagrama fundamental',
    html:
      'El gráfico de abajo a la derecha traza <b>flujo q</b> (veh/h por ' +
      'carril) contra <b>densidad k</b> (veh/km por carril), medidos por ' +
      'detectores en las calles más largas. Con poca densidad, más vehículos ' +
      '⇒ más flujo (<b>rama libre</b>). Pasado el punto crítico, añadir ' +
      'vehículos reduce el flujo (<b>rama congestionada</b>): la capacidad de ' +
      'la vía es el pico de la curva.',
  },
  {
    title: 'Experimentos sugeridos',
    html:
      '<ul>' +
      '<li>Sube la <b>demanda a 5000</b> y mira cómo el diagrama fundamental ' +
      'se dobla hacia la rama congestionada.</li>' +
      '<li>Baja el <b>ciclo semafórico a 30 s</b>: ¿mejoran o empeoran las ' +
      'colas?</li>' +
      '<li>Pon la velocidad a <b>0.25×</b> y haz clic en un vehículo para ' +
      'ver el IDM decidiendo en cámara lenta.</li>' +
      '<li>Compara <b>cortesía 0 y 1</b> con demanda alta: ¿más cambios de ' +
      'carril significan más flujo?</li>' +
      '<li>Busca otra ciudad (por ejemplo «Sopocachi, La Paz») y compara su ' +
      'red.</li>' +
      '</ul>',
  },
];

export function initExplainer() {
  const container = document.querySelector('#explainer details .body');
  if (!container) return;
  container.innerHTML = SECTIONS.map(
    (s) =>
      `<details class="exp-section"><summary>${s.title}</summary>` +
      `<div class="exp-body">${s.html}</div></details>`
  ).join('');
}
