# Simulador de Tráfico Urbano 3D — La Paz

Simulación **microscópica** de tráfico en 3D sobre la red vial real del centro
de La Paz, Bolivia (Plaza del Estudiante / Av. Villazón / El Prado), construida
con datos de OpenStreetMap. Cada vehículo es un agente individual que sigue,
frena, cambia de carril, respeta semáforos coordinados y cede el paso en los
cruces. La interfaz es didáctica: el objetivo es **ver** los fenómenos clásicos
de la ingeniería de tráfico — colas, ondas de choque, ondas verdes y el
diagrama fundamental — emerger de reglas locales simples.

Stack: [Vite](https://vitejs.dev) + JavaScript (módulos ES, sin framework),
[three.js](https://threejs.org) para el render y
[lil-gui](https://lil-gui.georgealways.com) para los controles.

## Cómo correr

Requisitos: Node.js ≥ 20.

```bash
npm install
npm run dev        # servidor de desarrollo en http://localhost:5173
npm run build      # build de producción en dist/
npm run preview    # sirve dist/
npx playwright test            # suite e2e completa
npx playwright test -g "viva"  # un solo test por nombre
```

La zona por defecto carga **sin conexión** desde instantáneas incluidas en
`public/data/` (red vial + edificios). Internet solo hace falta para buscar
otras zonas.

## Los modelos

### IDM — Intelligent Driver Model (seguimiento)

Cada vehículo ajusta su aceleración de forma continua:

```
a = a_máx · [ 1 − (v/v₀)^δ − (s*/s)² ]
s* = s₀ + v·T + v·Δv / (2·√(a_máx·b))
```

donde `v` es su velocidad, `v₀` la deseada, `s` el hueco real con el líder,
`Δv` la velocidad de aproximación y `s*` el hueco deseado. Un solo modelo
produce aceleración libre, seguimiento estable y frenadas de emergencia.
Parámetros por defecto: `T ≈ 1.5 s`, `a ≈ 1.5 m/s²`, `b ≈ 2.0 m/s²`,
`s₀ ≈ 2 m`, `δ = 4`, con variación aleatoria de ±10 % por vehículo
(80 % autos, 12 % camiones lentos, 8 % deportivos rápidos).

> Treiber, Hennecke & Helbing (2000), *Congested traffic states in empirical
> observations and microscopic simulations*, Phys. Rev. E 62, 1805.

### MOBIL — cambios de carril

Un vehículo cambia de carril cuando su ganancia de aceleración supera la
pérdida que impone a los demás, ponderada por el **factor de cortesía p**
(control en vivo en el panel), y nunca si el nuevo seguidor tendría que frenar
más fuerte que un umbral de seguridad. Los cambios obligatorios por ruta
(carril sin conector hacia la siguiente calle) anulan el incentivo y solo
exigen seguridad.

> Kesting, Treiber & Helbing (2007), *General lane-changing model MOBIL for
> car-following models*, Transp. Res. Rec. 1999, 86–94.

### Semáforos y ondas verdes

Los cruces semaforizados (detectados desde OSM + heurística para cruces
grandes) alternan dos fases (eje N-S / eje E-O) con ámbar de 3 s y todo-rojo
de 2 s. El reparto de verde es proporcional a los carriles de cada eje y los
**desfases** entre cruces se calculan proyectando cada cruce sobre el eje
dominante de la red a la velocidad de onda verde (50 km/h por defecto):
un pelotón que viaje a esa velocidad encadena verdes. Ciclo y velocidad de
onda son ajustables en vivo.

La luz roja se modela como un **obstáculo virtual detenido** en la línea de
parada; el ámbar solo detiene si la frenada es cómoda. En los giros, los
movimientos de menor prioridad (izquierda < derecha < recto) ceden el paso si
un vehículo prioritario llega en menos de 4 s, con un rompe-bloqueos por
inanición a los 8 s.

## Controles

| Control | Efecto |
|---|---|
| **Demanda (veh/h)** | Tasa de llegadas Poisson en las entradas de la red (0–6000) |
| **Velocidad de simulación** | 0.25×–4× + botón de pausa |
| **Cortesía (MOBIL)** | p = 0 egoísta … p = 1 altruista |
| **Ciclo semafórico (s)** | 30–120 s, retemporiza todos los cruces en vivo |
| **Onda verde (km/h)** | Velocidad de progresión de los desfases |
| **Sombras / overlays de debug** | Render |
| **Clic sobre un vehículo** | Cámara de seguimiento + panel IDM en vivo (velocidad, aceleración, hueco, estado). Esc o clic en el vacío para salir |
| **Buscador (arriba)** | Nombre de lugar, URL de Google Maps o `lat, lon` |

HUD (arriba a la izquierda): vehículos activos, velocidad media, flujo
(veh/h/carril), densidad (veh/km/carril), tiempo de simulación y ms/paso.

## Fenómenos a observar

- **Colas en rojo y disipación en verde**: mira un cruce de El Prado con
  demanda media; la cola crece en rojo y se disuelve como onda de arranque.
- **Onda verde**: sigue a un vehículo por la avenida principal con el ciclo
  por defecto; con suerte encadenará varios verdes.
- **Ondas de choque (stop-and-go)**: con demanda ≥ 4000, pequeñas frenadas se
  amplifican corriente arriba: verás bandas de paradas que viajan hacia atrás
  aunque no haya ningún obstáculo. El atasco fantasma clásico.
- **Diagrama fundamental** (panel inferior derecho): cada punto es un detector
  en una ventana de 60 s. Con poca demanda los puntos suben por la **rama
  libre** (q ∝ k); al saturar la red, la nube se dobla y cae por la **rama
  congestionada**. Sube la demanda a 5000 y observa la transición.
- **Cortesía**: con p = 0 y demanda alta, los cambios de carril oportunistas
  generan más frenadas; compara con p = 1.

## Cargar otra ciudad

Escribe en el buscador y pulsa **Buscar** (o Enter):

- un nombre de lugar: `Sopocachi, La Paz`, `Plaza Murillo`, `Manhattan, New York`;
- una URL de Google Maps (se extrae `@lat,lon,zoom` y el zoom fija el radio);
- coordenadas directas: `-16.5, -68.13`.

La app geocodifica con Nominatim, descarga la red vial y los edificios desde
Overpass (con espejo de respaldo y timeout de 25 s), reconstruye carriles,
conectores de giro, semáforos, rutas y detectores, y reinicia la simulación.
El radio se limita a 250–1200 m y las zonas demasiado densas se reintentan
automáticamente con un radio menor. Si la descarga falla, se conserva la red
actual y se muestra un aviso.

## Despliegue

La app es un **sitio estático puro**: `npm run build` genera todo en `dist/`
(HTML + JS + instantáneas OSM de `public/data/`). No hay servidor propio ni
variables de entorno — Nominatim y Overpass se consultan directamente desde el
navegador del visitante.

El repositorio incluye un blueprint [`render.yaml`](render.yaml) para
[Render](https://render.com):

```yaml
services:
  - type: web
    runtime: static
    name: simulador-trafico-3d
    buildCommand: npm ci && npm run build
    staticPublishPath: dist
```

Para desplegar:

1. En el dashboard de Render: **New +** → **Blueprint** (usa `render.yaml`
   automáticamente) o **Static Site** (configura build y carpeta a mano con
   los mismos valores de arriba).
2. Conecta este repositorio de GitHub y autoriza el acceso.
3. Confirma y despliega. A partir de ahí, **cada push a `main` redespliega
   automáticamente**.

No hace falta configurar nada más: sin variables de entorno, sin base de
datos, sin reglas de rewrite (es una sola página).

## Arquitectura (resumen)

```
OSM (Overpass JSON)
  └─ osm/parse → network/graph (aristas dirigidas, SCC) → lanes → connectors
     → signals (fases + onda verde) → routing (Dijkstra inverso por salida)
        └─ sim/ motor de paso fijo (30 Hz): IDM + MOBIL + semáforos + conflictos
           └─ render/ three.js InstancedMesh (autos/camiones/deportivos),
              interpolación entre pasos, edificios reales extruidos
              └─ ui/ GUI, HUD, diagrama fundamental, seguimiento, buscador
```

Detalles de diseño completos en `docs/DESIGN-SPEC.md`; guía para agentes de
código en `CLAUDE.md`.
