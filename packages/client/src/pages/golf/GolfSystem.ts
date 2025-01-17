/**
 * @author HydraFire <github.com/HydraFire>
 * @author Josh Field <github.com/hexafield>
 * @author Gheric Speiginer <github.com/speigg>
 */

import { Engine } from '@xrengine/engine/src/ecs/classes/Engine'
import { World } from '@xrengine/engine/src/ecs/classes/World'
import { AssetLoader } from '@xrengine/engine/src/assets/classes/AssetLoader'
import { GolfAction, GolfActionType } from './GolfAction'
import { Network } from '@xrengine/engine/src/networking/classes/Network'
import { dispatchFromServer, dispatchFromClient } from '@xrengine/engine/src/networking/functions/dispatch'
import { createState, Downgraded } from '@hookstate/core'
import { isClient } from '@xrengine/engine/src/common/functions/isClient'
import { GolfBallTagComponent, GolfClubTagComponent, GolfPrefabs } from './prefab/GolfGamePrefabs'
import { NetworkObjectComponent } from '@xrengine/engine/src/networking/components/NetworkObjectComponent'
import {
  addComponent,
  defineQuery,
  getComponent,
  removeComponent
} from '@xrengine/engine/src/ecs/functions/ComponentFunctions'
import { AvatarComponent } from '@xrengine/engine/src/avatar/components/AvatarComponent'
import {
  BALL_STATES,
  initializeGolfBall,
  resetBall,
  setBallState,
  spawnBall,
  updateBall
} from './prefab/GolfBallPrefab'
import { initializeGolfClub, spawnClub, updateClub } from './prefab/GolfClubPrefab'
import { SpawnNetworkObjectComponent } from '@xrengine/engine/src/scene/components/SpawnNetworkObjectComponent'
import { GolfClubComponent } from './components/GolfClubComponent'
import { setupPlayerInput } from './functions/setupPlayerInput'
import { registerGolfBotHooks } from './functions/registerGolfBotHooks'
import {
  getCurrentGolfPlayerEntity,
  getGolfPlayerNumber,
  getGolfPlayerState,
  getPlayerEntityFromNumber
} from './functions/golfFunctions'
import { hitBall } from './functions/hitBall'
import { GolfBallComponent } from './components/GolfBallComponent'
import { getCollisions } from '@xrengine/engine/src/physics/functions/getCollisions'
import { VelocityComponent } from '@xrengine/engine/src/physics/components/VelocityComponent'
import { GolfHoleComponent } from './components/GolfHoleComponent'
import { TransformComponent } from '@xrengine/engine/src/transform/components/TransformComponent'
import { isEntityLocalClient } from '@xrengine/engine/src/networking/functions/isEntityLocalClient'
import { useState } from '@hookstate/core'
import { GolfTeeComponent } from './components/GolfTeeComponent'
import { NameComponent } from '@xrengine/engine/src/scene/components/NameComponent'
import { NetworkObjectOwnerComponent } from '@xrengine/engine/src/networking/components/NetworkObjectOwnerComponent'
import { setupPlayerAvatar, setupPlayerAvatarNotInVR, setupPlayerAvatarVR } from './functions/setupPlayerAvatar'
import { XRInputSourceComponent } from '@xrengine/engine/src/avatar/components/XRInputSourceComponent'
import { IncomingActionType } from '@xrengine/engine/src/networking/interfaces/NetworkTransport'
import { NetworkWorldAction } from '@xrengine/engine/src/networking/interfaces/NetworkWorldActions'
import { useWorld } from '@xrengine/engine/src/ecs/functions/SystemHooks'

export function getHole(world: World, i: number) {
  return world.namedEntities.get(`GolfHole-${i}`)
}
export function getBall(world: World, i: number) {
  return world.namedEntities.get(`GolfBall-${i}`)
}
export function getTee(world: World, i: number) {
  return world.namedEntities.get(`GolfTee-${i}`)
}
export function getClub(world: World, i: number) {
  return world.namedEntities.get(`GolfClub-${i}`)
}

/**
 *
 */
export const GolfState = createState({
  holes: [{ par: 3 }, { par: 3 }, { par: 3 }] as Array<{ par: number }>,
  players: [] as Array<{
    id: string
    scores: Array<number>
    stroke: number
    viewingScorecard: boolean
  }>,
  currentPlayer: 0,
  currentHole: 0
})

// Attach logging
GolfState.attach(() => ({
  id: Symbol('Logger'),
  init: () => ({
    onSet() {
      console.log('GOLF STATE \n' + JSON.stringify(GolfState.attach(Downgraded).value, null, 2))
    }
  })
}))

export function useGolfState() {
  return useState(GolfState)
}

const getTeePosition = (world: World, currentHole: number) => {
  const teeEntity = getTee(world, currentHole)
  return getComponent(teeEntity, TransformComponent).position.toArray()
}

// IMPORTANT : For FLUX pattern, consider state immutable outside a receptor
function golfReceptor(action: GolfActionType & IncomingActionType) {
  const world = useWorld()

  GolfState.batch((s) => {
    switch (action.type) {
      case 'puttclub.GAME_STATE': {
        // for (const eid of golfHoleQuery(world)) {
        //   s.holes.merge({
        //     [hole.number]:
        //   })
        // }
        s.merge(action.state)
        return
      }

      /**
       * On PLAYER_JOINED
       * - Add a player to player list (start at hole 0, scores at 0 for all holes)
       * - spawn golf club
       * - spawn golf ball
       */
      case 'puttclub.PLAYER_JOINED': {
        // this must happen on the server

        if (!isClient) {
          // player left ?
          const player = Object.values(Network.instance.networkObjects).find((obj) => obj.uniqueId === action.playerId)
          if (!player) return

          const playerAlreadyExists = s.players.find((p) => p.value.id === action.playerId)

          if (!playerAlreadyExists) {
            s.players.merge([
              {
                id: action.playerId,
                scores: [],
                stroke: 0,
                viewingScorecard: false
              }
            ])
            console.log(`player ${action.playerId} joined`)
          } else {
            console.log(`player ${action.playerId} rejoined`)
          }

          dispatchFromServer(GolfAction.sendState(s.attach(Downgraded).value))

          const { entity } = player

          console.log('namedEntities', JSON.stringify(world.namedEntities))

          // const playerNumber = getGolfPlayerNumber(entity)

          if (!getBall(world, getGolfPlayerNumber(entity))) {
            spawnBall(world, entity, GolfState.currentHole.value)
          }
          spawnClub(entity)
        }
        return
      }

      /**
       * on PLAYER_READY
       *   - IF player is current player, reset their ball position to the current tee
       */
      case 'puttclub.PLAYER_READY': {
        if (s.players.value.length && action.playerId === s.players.value[s.currentPlayer.value].id) {
          dispatchFromServer(
            GolfAction.resetBall(s.players.value[s.currentPlayer.value].id, getTeePosition(world, s.currentHole.value))
          )
        }
        return
      }

      /**
       * on PLAYER_STROKE
       *   - Finish current hole for this player
       *   - players[currentPlayer].scores[currentHole] = player.stroke
       */
      case 'puttclub.PLAYER_STROKE': {
        s.players[s.currentPlayer.value].merge((s) => {
          return { stroke: s.stroke + 1 }
        })
        const currentPlayerNumber = GolfState.currentPlayer.value
        const activeBallEntity = getBall(world, currentPlayerNumber)
        setBallState(activeBallEntity, BALL_STATES.MOVING)
        if (!isClient) ballTimer = 0
        return
      }

      /**
       * on BALL_STOPPED
       *   - Finish current hole for this player
       *   - players[currentPlayer].scores[currentHole] = player.stroke
       */
      case 'puttclub.BALL_STOPPED': {
        const currentPlayerNumber = GolfState.currentPlayer.value
        const entityBall = getBall(world, currentPlayerNumber)
        setBallState(entityBall, action.inHole ? BALL_STATES.IN_HOLE : BALL_STATES.STOPPED)
        if (isClient) {
          const teePosition = getTeePosition(world, s.currentHole.value)
          const position = action.outOfBounds ? teePosition : action.position
          resetBall(entityBall, position)
        }

        setTimeout(() => {
          dispatchFromServer(GolfAction.nextTurn())
        }, 1000)
        return
      }

      /**
       * on NEXT_TURN
       *   - next player is first of reduce(players => ball not in hole)
       *   - IF all balls in hole
       *     - Finish current hole for this player
       *     - players[currentPlayer].scores[currentHole] = player.stroke
       *     - IF all players have finished the current hole
       *       - dispatch NEXT_HOLE
       *   - ELSE
       *     - increment currentPlayer
       *     - hide old player's ball
       *     - show new player's ball
       */
      case 'puttclub.NEXT_TURN': {
        const currentPlayerNumber = s.currentPlayer.value
        const currentPlayer = s.players[currentPlayerNumber]
        const currentHole = s.currentHole.value
        const entityBall = getBall(world, currentPlayerNumber)
        const entityHole = getHole(world, currentHole)

        // if hole in ball or player has had too many shots, finish their round
        if (typeof entityBall !== 'undefined') {
          if (
            getComponent(entityBall, GolfBallComponent).state === BALL_STATES.IN_HOLE ||
            currentPlayer.stroke.value > 5 /**s.holes.value[s.currentHole].par.value + 3*/
          ) {
            console.log('=== PLAYER FINISHED HOLE')
            currentPlayer.scores.set([
              ...currentPlayer.scores.value,
              currentPlayer.stroke.value - s.holes[currentHole].par.value
            ])
          }

          setBallState(entityBall, BALL_STATES.INACTIVE)
        }

        // TODO: get player with fewest number of holes completed
        // const currentHole = s.players.reduce(() => {
        //   score.length
        // }, [score]) // or something

        const getPlayersYetToFinishRound = () => {
          const currentHole = s.currentHole.value
          const players = []
          for (const p of s.players.value) {
            // if player has finished less holes than the current hole index
            if (p.scores.length <= currentHole) players.push(p)
          }
          return players.concat(players) // concat so it wraps to players prior to the current player
        }

        // get players who haven't finished yet
        const playersYetToFinishRound = getPlayersYetToFinishRound()

        let hasWrapped = false
        const nextPlayer = playersYetToFinishRound.find((p, i) => {
          // get player number from index of p in all players
          const playerNumber = s.players.findIndex((player) => player.value.id === p.id)
          if (hasWrapped) return true
          if (i >= playersYetToFinishRound.length / 2 - 1) {
            hasWrapped = true
          }
          return playerNumber > currentPlayerNumber
        })

        // if we have a next player, increment the current player and change turns
        if (typeof nextPlayer !== 'undefined') {
          const nextPlayerNumber = s.players.findIndex((player) => player.value.id === nextPlayer.id)
          s.currentPlayer.set(nextPlayerNumber)

          // the ball might be in the old hole still
          if (nextPlayer.stroke === 0) {
            dispatchFromServer(GolfAction.resetBall(nextPlayer.id, getTeePosition(world, s.currentHole.value)))
          }

          const nextBallEntity = getBall(world, nextPlayerNumber)
          setBallState(nextBallEntity, BALL_STATES.WAITING)

          console.log(`it is now player ${nextPlayerNumber}'s turn`)
        } else {
          // if not, the round has finished
          dispatchFromServer(GolfAction.nextHole())
        }

        return
      }

      /**
       * on NEXT_HOLE
       *   - currentHole = earliest hole that a player hasn’t completed yet
       *   - indicate new current hole
       *   - dispatch RESET_BALL
       */
      case 'puttclub.NEXT_HOLE': {
        s.currentHole.set((s.currentHole.value + 1) % s.holes.length) // TODO: earliest incomplete hole
        if (s.currentHole.value === 0) {
          console.log('finished game! resetting player scores')
          for (const [i, p] of s.players.entries()) {
            p.scores.set([])
          }
        }
        // Set all player strokes to 0
        for (const [i, p] of s.players.entries()) {
          p.stroke.set(0)
          // reset all ball position to the new tee
        }

        // set current player to the first player
        s.currentPlayer.set(0)
        dispatchFromServer(GolfAction.resetBall(s.players[0].id.value, getTeePosition(world, s.currentHole.value)))

        //
        return
      }

      /**
       * on RESET_BALL
       * - teleport ball
       */
      case 'puttclub.RESET_BALL': {
        if (action.$userId !== 'server') return
        const playerNumber = s.players.findIndex((p) => p.value.id === action.playerId)
        const entityBall = getBall(world, playerNumber)
        if (typeof entityBall !== 'undefined') {
          // && getComponent(entityBall, GolfBallComponent).state === BALL_STATES.INACTIVE) {
          resetBall(entityBall, action.position)
          setBallState(entityBall, BALL_STATES.WAITING)
        }

        return
      }

      case 'puttclub.SHOW_SCORECARD': {
        const player = s.players.find((p) => p.value.id === action.$userId)
        if (player) player.viewingScorecard.set((v) => (typeof action.value === 'boolean' ? action.value : !v))
      }
    }
  })
}

// Note: player numbers are 0-indexed

globalThis.GolfState = GolfState
let ballTimer = 0

export default async function GolfSystem(world: World) {
  const playerQuery = defineQuery([AvatarComponent, NetworkObjectComponent])
  const namedComponentQuery = defineQuery([NameComponent])
  const spawnGolfBallQuery = defineQuery([SpawnNetworkObjectComponent, GolfBallTagComponent])
  const spawnGolfClubQuery = defineQuery([SpawnNetworkObjectComponent, GolfClubTagComponent])
  const golfClubQuery = defineQuery([GolfClubComponent])
  const playerVRQuery = defineQuery([AvatarComponent, XRInputSourceComponent])

  if (isClient) {
    registerGolfBotHooks()
    // pre-cache the assets we need for this game
    await AssetLoader.loadAsync({ url: Engine.publicPath + '/models/golf/avatars/avatar_head.glb' })
    await AssetLoader.loadAsync({ url: Engine.publicPath + '/models/golf/avatars/avatar_hands.glb' })
    await AssetLoader.loadAsync({ url: Engine.publicPath + '/models/golf/avatars/avatar_torso.glb' })
    await AssetLoader.loadAsync({ url: Engine.publicPath + '/models/golf/golf_ball.glb' })
  }

  // add our prefabs - TODO: find a better way of doing this that doesn't pollute prefab namespace
  Object.entries(GolfPrefabs).forEach(([prefabType, prefab]) => {
    Network.instance.schema.prefabs.set(prefabType, prefab)
  })

  world.receptors.add(golfReceptor)

  return () => {
    const currentPlayer = getGolfPlayerState()
    const playerEnterQueryResults = playerQuery.enter()

    if (isClient) {
      for (const entity of golfClubQuery()) {
        const { number } = getComponent(entity, GolfClubComponent)
        const ownerEntity = getPlayerEntityFromNumber(number)
        updateClub(entity)
        // we only need to detect hits for our own club
        if (typeof ownerEntity !== 'undefined' && isEntityLocalClient(ownerEntity)) {
          if (getCurrentGolfPlayerEntity() === ownerEntity) {
            const { uniqueId, networkId } = getComponent(ownerEntity, NetworkObjectComponent)
            const currentPlayerNumber = GolfState.currentPlayer.value
            const entityBall = getBall(world, currentPlayerNumber)

            if (entityBall && getComponent(entityBall, NetworkObjectOwnerComponent).networkId === networkId) {
              const { collisionEntity } = getCollisions(entity, GolfBallComponent)
              if (collisionEntity !== null && collisionEntity === entityBall) {
                const golfBallComponent = getComponent(entityBall, GolfBallComponent)
                if (golfBallComponent.state === BALL_STATES.WAITING) {
                  hitBall(entity, entityBall)
                  setBallState(entityBall, BALL_STATES.MOVING)
                  dispatchFromClient(GolfAction.playerStroke(uniqueId))
                }
              }
            }
          }
        }
      }
    } else {
      for (const entity of playerEnterQueryResults) {
        const { uniqueId } = getComponent(entity, NetworkObjectComponent)

        // Add a player to player list (start at hole 0, scores at 0 for all holes)
        dispatchFromServer(GolfAction.playerJoined(uniqueId))
      }

      for (const entity of playerQuery.exit()) {
        const { uniqueId } = getComponent(entity, NetworkObjectComponent, true)
        const playerNum = getGolfPlayerNumber(entity)
        console.log(`player ${playerNum} leave???`)
        // if a player disconnects and it's their turn, change turns to the next player
        if (currentPlayer?.id === uniqueId) dispatchFromServer(GolfAction.nextTurn())
        const clubEntity = getClub(world, playerNum)
        if (clubEntity)
          dispatchFromServer(
            NetworkWorldAction.destroyObject(getComponent(clubEntity, NetworkObjectComponent).networkId)
          )
        const ballEntity = getBall(world, playerNum)
        if (ballEntity)
          dispatchFromServer(
            NetworkWorldAction.destroyObject(getComponent(ballEntity, NetworkObjectComponent).networkId)
          )
      }
    }

    if (isClient) {
      for (const entity of playerEnterQueryResults) {
        setupPlayerAvatar(entity)
        setupPlayerInput(world, entity)
      }
    }

    for (const entity of namedComponentQuery.enter()) {
      const { name } = getComponent(entity, NameComponent)
      if (name) {
        console.log(name)
        if (name.includes('GolfHole')) {
          addComponent(entity, GolfHoleComponent, {})
        }
        if (name.includes('GolfTee')) {
          addComponent(entity, GolfTeeComponent, {})
        }
      }
    }

    const currentPlayerNumber = GolfState.currentPlayer.value
    const activeBallEntity = getBall(world, currentPlayerNumber)
    if (typeof activeBallEntity !== 'undefined') {
      const golfBallComponent = getComponent(activeBallEntity, GolfBallComponent)
      updateBall(activeBallEntity)

      if (!isClient && golfBallComponent.state === BALL_STATES.MOVING) {
        ballTimer++
        if (ballTimer > 60) {
          const { velocity } = getComponent(activeBallEntity, VelocityComponent)
          const velMag = velocity.lengthSq()
          if (velMag < 0.001) {
            setBallState(activeBallEntity, BALL_STATES.STOPPED)
            setTimeout(() => {
              const position = getComponent(activeBallEntity, TransformComponent)?.position
              if (!position) return

              golfBallComponent.groundRaycast.origin.copy(position)
              world.physics.doRaycast(golfBallComponent.groundRaycast)
              const outOfBounds = !golfBallComponent.groundRaycast.hits.length

              const activeHoleEntity = getHole(world, GolfState.currentHole.value)
              const { collisionEvent } = getCollisions(activeBallEntity, GolfHoleComponent)
              const dist = position.distanceToSquared(getComponent(activeHoleEntity, TransformComponent).position)
              // ball-hole collision not being detected, not sure why, use dist for now
              const inHole = dist < 0.01 //typeof collisionEvent !== 'undefined'
              console.log('\n\n\n========= ball stopped', outOfBounds, inHole, dist, collisionEvent, '\n')

              dispatchFromServer(
                GolfAction.ballStopped(
                  GolfState.players.value[currentPlayerNumber].id,
                  position.toArray(),
                  inHole,
                  outOfBounds
                )
              )
            }, 1000)
          }
        }
      }
    }

    /**
     * we use an plain query here in case the player and club/ball arrive at the client in the same frame,
     * as there can be a race condition between the two
     */
    for (const entity of spawnGolfBallQuery()) {
      const { parameters } = getComponent(entity, SpawnNetworkObjectComponent)
      const ownerEntity = getPlayerEntityFromNumber(parameters.playerNumber)
      if (typeof ownerEntity !== 'undefined') {
        removeComponent(entity, SpawnNetworkObjectComponent)
        // removeComponent(entity, GolfBallTagComponent)
        initializeGolfBall(entity, ownerEntity, parameters)
        if (GolfState.currentPlayer.value === parameters.playerNumber) {
          setBallState(entity, BALL_STATES.WAITING)
        } else {
          setBallState(entity, BALL_STATES.INACTIVE)
        }
      }
    }

    for (const entity of spawnGolfClubQuery()) {
      const { parameters } = getComponent(entity, SpawnNetworkObjectComponent)
      const ownerEntity = getPlayerEntityFromNumber(parameters.playerNumber)
      if (typeof ownerEntity !== 'undefined') {
        if (typeof parameters.playerNumber !== 'undefined') {
          const { parameters } = removeComponent(entity, SpawnNetworkObjectComponent)
          // removeComponent(entity, GolfClubTagComponent)
          initializeGolfClub(entity, ownerEntity, parameters)
          if (isEntityLocalClient(ownerEntity)) {
            console.log('i am ready')
            dispatchFromClient(GolfAction.playerReady(GolfState.players.value[parameters.playerNumber].id))
          }
        }
      }
    }

    if (isClient) {
      for (const entity of playerVRQuery.enter()) {
        setupPlayerAvatarVR(entity)
      }

      for (const entity of playerVRQuery.exit()) {
        setupPlayerAvatarNotInVR(entity)
      }
    }

    return world
  }
}
