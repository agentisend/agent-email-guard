<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Hosted;

/**
 * Resuming a killed key and approving a held send are a person's decisions,
 * made in the AgentiSend console. An API key cannot do either for itself.
 */
final class HumanActionRequired extends \LogicException
{
}
