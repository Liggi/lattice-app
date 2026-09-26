/* oxlint-disable react-doctor/no-array-index-as-key */
import { useState, useCallback, useMemo } from 'react'

// Isometric projection helpers
const ISO_ANGLE = Math.PI / 6 // 30 degrees
const COS_A = Math.cos(ISO_ANGLE)
const SIN_A = Math.sin(ISO_ANGLE)

// Convert 3D grid position to 2D isometric
function toIso(x: number, y: number, z: number, scale: number = 20, offsetX: number = 50, offsetY: number = 50): { x: number; y: number } {
  const isoX = (x - z) * COS_A * scale + offsetX
  const isoY = (x + z) * SIN_A * scale - y * scale + offsetY
  return { x: isoX, y: isoY }
}

// Color palette
const colors = {
  cyan: { base: '#22d3ee', glow: 'rgba(34,211,238,' },
  amber: { base: '#fbbf24', glow: 'rgba(251,191,36,' },
  purple: { base: '#a855f7', glow: 'rgba(168,85,247,' },
  emerald: { base: '#34d399', glow: 'rgba(52,211,153,' },
  rose: { base: '#fb7185', glow: 'rgba(251,113,133,' },
}

type ColorKey = keyof typeof colors

interface Node {
  id: string
  x: number
  y: number
  z: number
  iso: { x: number; y: number }
  color: ColorKey
}

interface Edge {
  from: string
  to: string
}

interface LatticeLogoProps {
  size?: number
  colorScheme?: 'mono' | 'gradient' | 'rainbow'
  interactive?: boolean
  className?: string
}

export function LatticeLogo({ size = 100, colorScheme = 'gradient', interactive = true, className }: LatticeLogoProps): JSX.Element {
  const [mouse, setMouse] = useState({ x: 50, y: 50 })

  // Generate 3x3x3 grid of nodes
  const { nodes, edges } = useMemo(() => {
    const nodeList: Node[] = []
    const edgeList: Edge[] = []

    // Create nodes
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        for (let z = 0; z < 3; z++) {
          const id = `${x}-${y}-${z}`
          const iso = toIso(x - 1, y - 1, z - 1, 15, 50, 50)

          // Color assignment based on scheme
          let color: ColorKey = 'cyan'
          if (colorScheme === 'gradient') {
            // Gradient from cyan (top) to purple (middle) to amber (bottom)
            if (y === 2) color = 'cyan'
            else if (y === 1) color = 'purple'
            else color = 'amber'
          } else if (colorScheme === 'rainbow') {
            const colorKeys: ColorKey[] = ['cyan', 'amber', 'purple', 'emerald', 'rose']
            color = colorKeys[(x + y + z) % colorKeys.length]
          }

          nodeList.push({ id, x, y, z, iso, color })
        }
      }
    }

    // Create edges (connect adjacent nodes)
    for (const node of nodeList) {
      const { x, y, z } = node
      // Connect to +x, +y, +z neighbors
      if (x < 2) edgeList.push({ from: node.id, to: `${x + 1}-${y}-${z}` })
      if (y < 2) edgeList.push({ from: node.id, to: `${x}-${y + 1}-${z}` })
      if (z < 2) edgeList.push({ from: node.id, to: `${x}-${y}-${z + 1}` })
    }

    return { nodes: nodeList, edges: edgeList }
  }, [colorScheme])

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!interactive) return
    const rect = e.currentTarget.getBoundingClientRect()
    setMouse({
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    })
  }, [interactive])

  const handleMouseLeave = useCallback(() => {
    if (!interactive) return
    setMouse({ x: 50, y: 50 }) // Reset to center
  }, [interactive])

  const getNodeInfluence = useCallback((node: Node) => {
    if (!interactive) return 0.2 // Dimmer default state
    const dx = mouse.x - node.iso.x
    const dy = mouse.y - node.iso.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    const maxDist = 45
    // Softer curve: max out at 0.7 instead of 1.0
    return Math.max(0.15, 0.7 * (1 - dist / maxDist))
  }, [mouse, interactive])

  const getEdgeInfluence = useCallback((fromNode: Node, toNode: Node) => {
    if (!interactive) return 0.15 // Dimmer edges
    const midX = (fromNode.iso.x + toNode.iso.x) / 2
    const midY = (fromNode.iso.y + toNode.iso.y) / 2
    const dx = mouse.x - midX
    const dy = mouse.y - midY
    const dist = Math.sqrt(dx * dx + dy * dy)
    const maxDist = 50
    // Softer curve: max out at 0.6 instead of 1.0
    return Math.max(0.1, 0.6 * (1 - dist / maxDist))
  }, [mouse, interactive])

  // Sort nodes by depth for proper rendering (back to front)
  const sortedNodes = useMemo(() => {
    return [...nodes].sort((a, b) => (a.x + a.z) - (b.x + b.z))
  }, [nodes])

  const nodeMap = useMemo(() => {
    const map = new Map<string, Node>()
    for (const node of nodes) {
      map.set(node.id, node)
    }
    return map
  }, [nodes])

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={className}
    >
      <defs>
        {/* Glow filters for each color */}
        {Object.entries(colors).map(([name, color]) => (
          <filter key={name} id={`glow-${name}`} x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feFlood floodColor={color.base} result="color" />
            <feComposite in="color" in2="blur" operator="in" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        ))}
      </defs>

      {/* Edges */}
      {edges.map((edge, i) => {
        const fromNode = nodeMap.get(edge.from)!
        const toNode = nodeMap.get(edge.to)!
        const influence = getEdgeInfluence(fromNode, toNode)
        const color = colors[fromNode.color]

        return (
          <line
            key={i}
            x1={fromNode.iso.x}
            y1={fromNode.iso.y}
            x2={toNode.iso.x}
            y2={toNode.iso.y}
            stroke={color.base}
            strokeWidth={1.5}
            opacity={influence}
            style={{ transition: interactive ? 'opacity 0.15s ease-out' : undefined }}
          />
        )
      })}

      {/* Nodes (sorted back to front) */}
      {sortedNodes.map((node) => {
        const influence = getNodeInfluence(node)
        const color = colors[node.color]
        const radius = 3 + influence * 2

        return (
          <g key={node.id}>
            {/* Outer glow - only when fairly close */}
            {influence > 0.35 && (
              <circle
                cx={node.iso.x}
                cy={node.iso.y}
                r={radius + influence * 4}
                fill={`${color.glow}${influence * 0.2})`}
                style={{ transition: interactive ? 'all 0.15s ease-out' : undefined }}
              />
            )}
            {/* Main node */}
            <circle
              cx={node.iso.x}
              cy={node.iso.y}
              r={radius}
              fill={color.base}
              opacity={0.2 + influence * 0.6}
              filter={influence > 0.5 ? `url(#glow-${node.color})` : undefined}
              style={{ transition: interactive ? 'all 0.15s ease-out' : undefined }}
            />
          </g>
        )
      })}
    </svg>
  )
}
