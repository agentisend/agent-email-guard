<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/** The guard refused the send. Nothing was sent; $decision says why. */
final class GuardRefused extends GuardException
{
}
