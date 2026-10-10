import patch from '../assets/logos/odz-logo-patch.png'
import { ButtonLink } from '../components'

/**
 * Public splash (`/`). Login only: no sign-up, join or request-access button and no description
 * of how people are admitted (signup is invite-only, MVA-199). Sign-in fields wait on that ticket.
 */
export default function Landing() {
  return (
    <div className="odz odz-splash">
      <div className="odz-splash__top">
        <span className="odz-label">ODZ · Detachment HQ</span>
        <span className="odz-label">Est. 2015</span>
      </div>
      <div className="odz-splash__main">
        <img
          className="odz-splash__patch"
          src={patch}
          alt="Operational Detachment Zulu seal"
          width={320}
          height={320}
        />
        <div>
          <span className="odz-rocker">OPERATOR HUB</span>
          <h1 className="odz-hero" style={{ marginTop: '0.875rem' }}>
            ZULU
          </h1>
          <p className="odz-fullname">OPERATIONAL DETACHMENT ZULU</p>
          <p className="odz-motto">
            <em>Aut viam aut faciam.</em> We find a way, or we make one.
          </p>
          <div className="odz-row" style={{ marginTop: '1.5rem' }}>
            <ButtonLink to="/login" block>
              Sign in
            </ButtonLink>
          </div>
        </div>
      </div>
    </div>
  )
}
