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
    title: 'Micros y paradas',
    html:
      'Los <b>micros</b> (12% de la flota) sirven paradas reales de OSM ' +
      '(<code>highway=bus_stop</code>; 7 en la zona por defecto, marcadas ' +
      'con poste y banca). Al entrar a una calle con parada, el micro decide ' +
      'servirla con probabilidad 0.85, frena hacia ella con el mismo IDM y ' +
      'se detiene entre 8 y 25 s (media configurable con «Parada media»). ' +
      'Mientras tanto bloquea su carril: los demás hacen cola o lo adelantan ' +
      'por la izquierda vía MOBIL — el clásico cuello de botella paceño. ' +
      'Desactívalas con «Paradas de micro» y compara el flujo.',
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
    title: 'Mapa de calor de congestión',
    html:
      'Activa <b>Mapa de calor</b> (carpeta Vista) para pintar cada calle ' +
      'según su <b>velocidad relativa</b>: la velocidad media de sus ' +
      'vehículos dividida por el límite de la vía, suavizada con una media ' +
      'exponencial (τ ≈ 5 s). <b>Verde</b> = flujo libre (≥ 80 %), ' +
      '<b>amarillo</b> = circulación densa, <b>rojo</b> = atasco (≤ 20 %). ' +
      'En calles de doble sentido se muestra el sentido más congestionado y ' +
      'los cruces conservan el color del asfalto. Sube la demanda y observa ' +
      'cómo el rojo se propaga hacia atrás desde los semáforos.',
  },
  {
    title: 'Diagrama espacio-tiempo',
    html:
      'El segundo gráfico traza la <b>trayectoria</b> de cada vehículo sobre ' +
      'el corredor principal de la red (la vía continua más larga, indicada ' +
      'en el título): eje x = tiempo, eje y = distancia recorrida. Cada ' +
      'punto se colorea por velocidad (verde = fluido, rojo = detenido). ' +
      'Líneas inclinadas = avance (más pendiente ⇒ más rápido); escalones ' +
      'horizontales = colas. Con congestión, las <b>bandas rojas se ' +
      'desplazan en diagonal hacia atrás</b>: son las ondas de choque ' +
      'viajando contracorriente.',
  },
  // --- C1 --- (V3)
  {
    title: 'Obras e incidentes',
    html:
      'Activa <b>Modo obras</b> y haz clic sobre una calle para cerrarla ' +
      '(ambos sentidos): los vehículos adentro salen y <b>recalculan su ' +
      'ruta</b>, nadie nuevo entra, los conos marcan el cierre. ' +
      '<b>Provocar incidente</b> detiene un vehículo 90 s en un solo ' +
      'carril: cola por IDM detrás y, si hay otro carril, MOBIL genera el ' +
      'adelantamiento — míralo con el mapa de calor.',
  },
  // --- end C1 ---
  // --- C2 --- (V3)
  {
    title: 'Clima y ciclo día/noche',
    html:
      'Con <b>lluvia</b> todos bajan su velocidad deseada (×0.8), amplían ' +
      'el hueco (+0.4 s) y frenan más suave: la capacidad cae sin tocar la ' +
      'demanda. La <b>hora del día</b> mueve el sol, enciende faros, ' +
      'farolas y ventanas. Experimento: misma demanda 12:00 despejado vs ' +
      '22:00 lluvia — mira el diagrama fundamental.',
  },
  // --- end C2 ---
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
      '<li>Cierra la avenida principal con <b>Modo obras</b> y mira el ' +
      're-ruteo en el mapa de calor.</li>' + // V3 C1
      '<li>Activa <b>lluvia</b> con demanda alta y compárala con un día ' +
      'despejado en el diagrama fundamental.</li>' + // V3 C2
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
